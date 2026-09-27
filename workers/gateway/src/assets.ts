// Раздача статики воркеров (wrangler [assets]). Файлы — на диске по хэшу
// (/data/assets/<hh>/<hash>, disk-сервис только для чтения), манифест версии — в реестре.
//
// Правила как у Cloudflare (упрощённо, без редиректов):
//   html_handling (кроме "none"): /about → /about.html или /about/index.html; /dir/ → /dir/index.html
//   not_found_handling: "404-page" → /404.html со статусом 404,
//                       "single-page-application" → /index.html со статусом 200
import type { AssetConfig, AssetFile, VersionInfo } from "../../api/src/registry";
import type { Env } from "./env";
import { registry } from "./env";

// Информация о версии не меняется (новая версия — новый номер), кэшируем навсегда
const infos = new Map<string, Promise<VersionInfo>>();

export function versionInfo(env: Env, name: string, version: number): Promise<VersionInfo> {
  const key = `${name}@${version}`;
  let info = infos.get(key);
  if (!info) {
    info = registry(env).info(version) as Promise<VersionInfo>;
    info.catch(() => infos.delete(key));
    infos.set(key, info);
  }
  return info;
}

function candidates(path: string, config: AssetConfig): string[] {
  if (config.html_handling === "none") return [path];
  if (path.endsWith("/")) return [`${path}index.html`];
  if (/\.[^/]+$/.test(path)) return [path];
  return [path, `${path}.html`, `${path}/index.html`];
}

async function respond(env: Env, request: Request, file: AssetFile, status = 200): Promise<Response> {
  const etag = `"${file.hash}"`;
  const headers = new Headers({ etag, "cache-control": "public, max-age=0, must-revalidate" });
  if (file.contentType) headers.set("content-type", file.contentType);

  if (status === 200 && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const stored = await env.ASSET_FILES.fetch(`http://assets/assets/${file.hash.slice(0, 2)}/${file.hash}`);
  if (!stored.ok) return new Response("asset missing on disk", { status: 500 });
  return new Response(request.method === "HEAD" ? null : stored.body, { status, headers });
}

/**
 * Отдаёт статику. Возвращает null, если файла нет и запрос надо отдать коду воркера
 * (fallthrough = у воркера есть код). Без кода — применяет not_found_handling.
 */
export async function serveAsset(
  env: Env,
  request: Request,
  assets: NonNullable<VersionInfo["assets"]>,
  fallthrough: boolean,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fallthrough ? null : new Response("method not allowed", { status: 405 });
  }

  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  for (const candidate of candidates(path, assets.config)) {
    const file = assets.files[candidate];
    if (file) return respond(env, request, file);
  }
  if (fallthrough) return null;

  const notFound = assets.config.not_found_handling;
  if (notFound === "single-page-application" && assets.files["/index.html"]) {
    return respond(env, request, assets.files["/index.html"]);
  }
  if (notFound === "404-page" && assets.files["/404.html"]) {
    return respond(env, request, assets.files["/404.html"], 404);
  }
  return new Response("not found", { status: 404 });
}
