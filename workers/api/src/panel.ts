// Веб-панель платформы: panel.<ROOT_DOMAIN>
//
//   /api/*  — JSON для React-приложения (panel/), сессия в cookie
//   всё остальное — собранное приложение из образа (/app/panel, disk-сервис PANEL_UI),
//                   неизвестные пути → index.html (маршрутизация на клиенте)
//
// Вход по токену платформы (тот же, что у wravler). Cookie — HttpOnly, Secure,
// SameSite=Strict; изменяющие запросы дополнительно требуют заголовок X-Panel,
// который чужая страница без CORS отправить не может.
import type { Registry } from "./registry";
import type { TailHub } from "./tail";

interface PanelEnv {
  API_TOKEN?: string;
  ROOT_DOMAIN: string;
  REGISTRY: DurableObjectNamespace<Registry>;
  TAILS: DurableObjectNamespace<TailHub>;
  PANEL_UI: Fetcher;
}

const COOKIE = "panel_token";
const SESSION_DAYS = 30;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

export async function handlePanel(request: Request, env: PanelEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    const response = await handleApi(request, url, env);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  return serveApp(url, env);
}

// --- JSON API -------------------------------------------------------------------

async function handleApi(request: Request, url: URL, env: PanelEnv): Promise<Response> {
  const path = url.pathname.slice("/api".length);
  const method = request.method;

  if (method !== "GET" && request.headers.get("x-panel") !== "1") {
    return json({ error: "forbidden" }, 403);
  }

  if (method === "POST" && path === "/login") {
    const body = (await request.json().catch(() => ({}))) as { token?: string };
    const token = String(body.token ?? "").trim();
    if (!(await tokenMatches(token, env))) return json({ error: "Неверный токен" }, 401);
    return json({ ok: true }, 200, sessionCookie(token, SESSION_DAYS * 86400));
  }

  const authenticated = await tokenMatches(cookie(request, COOKIE), env);

  if (method === "GET" && path === "/session") {
    return json({ authenticated, rootDomain: env.ROOT_DOMAIN });
  }
  if (!authenticated) return json({ error: "unauthorized" }, 401);

  if (method === "POST" && path === "/logout") {
    return json({ ok: true }, 200, sessionCookie("", 0));
  }

  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("main"));

  if (method === "GET" && path === "/workers") {
    return json(await registry.list());
  }

  const worker = path.match(/^\/workers\/([a-z0-9-]{1,63})(\/[a-z]+)?$/);
  if (!worker) return json({ error: "not found" }, 404);
  const [, name, sub = ""] = worker;

  if (method === "GET" && sub === "") {
    const detail = await registry.detail(name);
    return detail ? json(detail) : json({ error: "Воркер не найден" }, 404);
  }
  if (method === "DELETE" && sub === "") {
    return (await registry.remove(name)) ? json({ ok: true }) : json({ error: "Воркер не найден" }, 404);
  }
  if (method === "GET" && sub === "/versions") {
    return json(await registry.versionsOf(name));
  }
  if (method === "POST" && sub === "/rollback") {
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const ok = typeof body.version === "number" && (await registry.setActive(name, body.version));
    return ok ? json({ ok: true }) : json({ error: "Версия не найдена" }, 404);
  }
  if (method === "POST" && sub === "/secrets") {
    const body = (await request.json().catch(() => ({}))) as { name?: string; value?: string };
    if (!body.name || typeof body.value !== "string") return json({ error: "нужны имя и значение" }, 400);
    return changeSecrets(registry, name, { [body.name]: body.value });
  }
  if (method === "DELETE" && sub === "/secrets") {
    const key = url.searchParams.get("name") ?? "";
    return changeSecrets(registry, name, { [key]: null });
  }
  if (method === "POST" && sub === "/tail") {
    if ((await registry.activeVersion(name)) === null) return json({ error: "Воркер не найден" }, 404);
    const session = await env.TAILS.get(env.TAILS.idFromName(name)).createSession();
    return json({ id: session.id, url: `wss://api.${env.ROOT_DOMAIN}/tail/${name}/${session.id}` });
  }
  if (method === "DELETE" && sub === "/tail") {
    const id = url.searchParams.get("id") ?? "";
    if (/^[0-9a-f-]{36}$/.test(id)) await env.TAILS.get(env.TAILS.idFromName(name)).deleteSession(id);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

async function changeSecrets(
  registry: DurableObjectStub<Registry>,
  name: string,
  changes: Record<string, string | null>,
): Promise<Response> {
  try {
    const version = await registry.changeSecrets(name, changes);
    return version === null ? json({ error: "Воркер не найден" }, 404) : json({ ok: true, version });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

// --- приложение ---------------------------------------------------------------------

async function serveApp(url: URL, env: PanelEnv): Promise<Response> {
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const isFile = /^\/[\w./-]+\.[a-z0-9]+$/.test(path) && !path.includes("..");

  if (isFile) {
    const file = await env.PANEL_UI.fetch(`http://panel${path}`);
    if (file.ok) return appFile(file, path);
    if (path.startsWith("/assets/")) return new Response("not found", { status: 404 });
  }
  // маршруты приложения (/workers/<имя>/...) отдаёт index.html
  const index = await env.PANEL_UI.fetch("http://panel/index.html");
  if (!index.ok) return new Response("панель не собрана", { status: 500 });
  return appFile(index, "/index.html");
}

function appFile(file: Response, path: string): Response {
  const ext = path.split(".").pop() ?? "";
  const headers = new Headers({
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    // файлы из /assets/ собраны Vite с хэшем в имени — их можно кэшировать навсегда
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  if (ext === "html") {
    headers.set(
      "content-security-policy",
      "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
  }
  return new Response(file.body, { status: 200, headers });
}

// --- помощники ---------------------------------------------------------------------

function json(data: unknown, status = 200, setCookie?: string): Response {
  const response = Response.json(data, { status });
  if (setCookie) response.headers.set("set-cookie", setCookie);
  return response;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function tokenMatches(candidate: string, env: PanelEnv): Promise<boolean> {
  if (!env.API_TOKEN || !candidate) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.API_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function cookie(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}
