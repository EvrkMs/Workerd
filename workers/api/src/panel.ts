// Веб-панель платформы: panel.<ROOT_DOMAIN>
//   GET  /        — список задеплоенных воркеров (служебных gateway/api в реестре нет)
//   POST /delete  — удалить воркер со всеми версиями
//   POST /login   — вход по токену платформы (тот же, что у wravler)
//   POST /logout
//
// Сессия — HttpOnly-cookie с токеном, SameSite=Strict: чужой сайт не может отправить
// форму от имени залогиненного браузера. Страницы рендерятся на сервере, без фреймворков.
import type { Registry, WorkerSummary } from "./registry";

interface PanelEnv {
  API_TOKEN?: string;
  ROOT_DOMAIN: string;
  REGISTRY: DurableObjectNamespace<Registry>;
}

const COOKIE = "panel_token";
const SESSION_DAYS = 30;

export async function handlePanel(request: Request, env: PanelEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/login") {
    const token = String((await request.formData()).get("token") ?? "").trim();
    if (!(await tokenMatches(token, env))) {
      return html(loginPage("Неверный токен"), 401);
    }
    return redirect("/", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
  }

  if (!(await tokenMatches(cookie(request, COOKIE), env))) {
    return request.method === "GET" && path === "/" ? html(loginPage()) : redirect("/");
  }

  if (request.method === "POST" && path === "/logout") {
    return redirect("/", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  }

  if (request.method === "POST" && path === "/delete") {
    const name = String((await request.formData()).get("name") ?? "");
    const removed = await registry(env).remove(name);
    return redirect(`/?${removed ? "deleted" : "missing"}=${encodeURIComponent(name)}`);
  }

  if (request.method === "GET" && path === "/") {
    const workers = await registry(env).list();
    const notice = url.searchParams.has("deleted")
      ? `Воркер «${url.searchParams.get("deleted")}» удалён.`
      : url.searchParams.has("missing")
        ? `Воркера «${url.searchParams.get("missing")}» уже нет.`
        : "";
    return html(listPage(workers, env.ROOT_DOMAIN, notice));
  }

  return new Response("not found", { status: 404 });
}

// --- помощники ---------------------------------------------------------------

function registry(env: PanelEnv) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
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

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ location });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });
}

// --- страницы -----------------------------------------------------------------

function layout(title: string, content: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df; --accent: #1d1d1b; --danger: #b42318; --ok: #1f7a3a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --card: #1f1f1d; --text: #ececea; --muted: #9a9a94; --line: #33332f; --accent: #ececea; --danger: #f97066; --ok: #6cd48a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 56rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: .6rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .7rem .9rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-weight: 500; color: var(--muted); font-size: .85rem; }
  tr:last-child td { border-bottom: 0; }
  td.num { font-variant-numeric: tabular-nums; }
  a { color: inherit; }
  code { font: .9em ui-monospace, SFMono-Regular, Consolas, monospace; }
  button { font: inherit; border-radius: .4rem; padding: .35rem .8rem; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--text); }
  button.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
  button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .notice { padding: .7rem .9rem; margin-bottom: 1rem; border-left: 3px solid var(--ok); }
  .empty { padding: 2rem; text-align: center; }
  form.inline { display: inline; margin: 0; }
  input[type=password] { font: inherit; width: 100%; padding: .5rem .7rem; border-radius: .4rem; border: 1px solid var(--line); background: var(--bg); color: var(--text); margin: .5rem 0 1rem; }
  .login { max-width: 24rem; margin: 15vh auto 0; padding: 1.5rem; }
  .error { color: var(--danger); }
  @media (max-width: 40rem) { .hide-sm { display: none; } th, td { padding: .6rem .5rem; } }
</style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function loginPage(error = ""): string {
  return layout("Вход · workerd", `
<form class="card login" method="post" action="/login">
  <h1>Панель workerd</h1>
  <p class="muted">Токен платформы — тот же, что у wravler (<code>~/.config/wravler/token</code>).</p>
  ${error ? `<p class="error">${escape(error)}</p>` : ""}
  <input type="password" name="token" autocomplete="current-password" placeholder="Токен" required autofocus>
  <button class="primary" type="submit">Войти</button>
</form>`);
}

function listPage(workers: WorkerSummary[], rootDomain: string, notice: string): string {
  const rows = workers
    .map(
      (w) => `
    <tr>
      <td><a href="https://${escape(w.name)}.${escape(rootDomain)}/" target="_blank" rel="noopener"><code>${escape(w.name)}</code></a></td>
      <td class="num">v${w.version}<span class="muted hide-sm"> · ${w.versions} ${plural(w.versions, "версия", "версии", "версий")}</span></td>
      <td class="num hide-sm">${escape(formatDate(w.createdAt))}</td>
      <td class="num">${escape(formatDate(w.updatedAt))}</td>
      <td style="text-align:right">
        <form class="inline" method="post" action="/delete"
              onsubmit="return confirm('Удалить воркер «${escape(w.name)}» со всеми версиями? Его адрес перестанет отвечать.')">
          <input type="hidden" name="name" value="${escape(w.name)}">
          <button class="danger" type="submit">Удалить</button>
        </form>
      </td>
    </tr>`,
    )
    .join("");

  const table = workers.length
    ? `<table>
        <thead><tr><th>Воркер</th><th>Версия</th><th class="hide-sm">Создан</th><th>Обновлён</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p class="empty muted">Воркеров нет. Задеплой: <code>wravler deploy</code></p>`;

  return layout("Воркеры · workerd", `
<header>
  <div>
    <h1>Воркеры</h1>
    <div class="muted">${workers.length} на <code>*.${escape(rootDomain)}</code> · время московское</div>
  </div>
  <form class="inline" method="post" action="/logout"><button type="submit">Выйти</button></form>
</header>
${notice ? `<div class="card notice">${escape(notice)}</div>` : ""}
<div class="card">${table}</div>`);
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
