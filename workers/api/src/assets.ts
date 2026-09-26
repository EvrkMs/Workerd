// Загрузка статики (wrangler [assets]) — протокол Cloudflare:
//   1. POST .../scripts/<имя>/assets-upload-session  {manifest: {"/путь": {hash, size}}}
//        → {jwt, buckets}: какие файлы (по хэшу) ещё не загружены, пачками
//   2. POST .../workers/assets/upload?base64=true     Authorization: Bearer <jwt сессии>
//        multipart: поле = хэш, значение = файл в base64 → {jwt: <completion>}
//   3. PUT  .../scripts/<имя>  metadata.assets = {jwt: <completion>, config}
//
// jwt здесь — неподписанная обёртка над id сессии: wrangler его не проверяет,
// а проверяем мы по реестру (id — случайный UUID, выдаётся только по токену API).
// Файлы хранятся по хэшу: одинаковые файлы разных версий и воркеров — один раз.
import type { Registry } from "./registry";

const HASH = /^[0-9a-f]{32,64}$/;
const BUCKET_SIZE = 20;

type Kind = "upload" | "complete";

export function assetFilePath(hash: string): string {
  return `assets/${hash.slice(0, 2)}/${hash}`;
}

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sessionToken(kind: Kind, sessionId: string): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sid: sessionId, kind, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${header}.${payload}.`;
}

export function parseSessionToken(token: string, kind: Kind): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
      sid?: unknown;
      kind?: unknown;
    };
    return payload.kind === kind && typeof payload.sid === "string" ? payload.sid : null;
  } catch {
    return null;
  }
}

/** Манифест wrangler → путь → хэш (с проверкой формата). */
export function parseManifest(raw: unknown): Record<string, string> | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "в запросе нет manifest" };
  const manifest: Record<string, string> = {};
  for (const [path, entry] of Object.entries(raw as Record<string, { hash?: unknown }>)) {
    if (!path.startsWith("/") || path.includes("..")) return { error: `некорректный путь статики: ${path}` };
    const hash = entry?.hash;
    if (typeof hash !== "string" || !HASH.test(hash)) return { error: `некорректный хэш для ${path}` };
    manifest[path] = hash;
  }
  return manifest;
}

export function buckets(hashes: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < hashes.length; i += BUCKET_SIZE) out.push(hashes.slice(i, i + BUCKET_SIZE));
  return out;
}

/** Шаг 2: приём пачки файлов. Авторизация — jwt сессии, не токен API. */
export async function handleAssetUpload(
  request: Request,
  registry: DurableObjectStub<Registry>,
  storage: Fetcher,
): Promise<{ status: number; error?: string; jwt?: string }> {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const sessionId = parseSessionToken(bearer, "upload");
  const session = sessionId ? await registry.assetSession(sessionId) : null;
  if (!sessionId || !session) return { status: 401, error: "сессия загрузки статики не найдена или истекла" };

  const allowed = new Set(Object.values(session.manifest));
  const form = await request.formData();
  for (const [hash, value] of form.entries()) {
    if (!allowed.has(hash)) return { status: 400, error: `файл ${hash} не входит в манифест сессии` };
    if (typeof value === "string") return { status: 400, error: `файл ${hash}: ожидался файл` };

    const bytes = Uint8Array.from(atob(await value.text()), (c) => c.charCodeAt(0));
    const put = await storage.fetch(`http://storage/${assetFilePath(hash)}`, { method: "PUT", body: bytes });
    if (!put.ok) return { status: 500, error: `не удалось записать ${hash}: HTTP ${put.status}` };

    // wrangler шлёт application/null, если тип файла не определён
    const type = value.type.split(";")[0].trim();
    await registry.recordAssetBlob(hash, type && type !== "application/null" ? value.type : null, bytes.byteLength);
  }
  return { status: 200, jwt: sessionToken("complete", sessionId) };
}
