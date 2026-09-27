// Служебные модули, которые платформа кладёт в контейнер рядом с кодом воркера.
//
// __platform.js — главный модуль воркера. Реэкспортирует код пользователя и:
//   - восстанавливает request.url (gateway шлёт запрос на worker-<имя>:8080, настоящий
//     адрес — в заголовке x-platform-url);
//   - превращает служебные биндинги __SVC_<ИМЯ> в env.<ИМЯ> другого воркера:
//     fetch() — HTTP, любой другой метод — RPC (JSON с типами, codec.ts: RPC между
//     процессами workerd сам не умеет);
//   - экспортирует __PlatformEntry — вход для service bindings других воркеров (порт 8081)
//     и для панели: просмотр данных Durable Object (с токеном платформы).
// Durable Objects здесь не эмулируются: они нативные (durableObjectNamespaces в конфиге).
// Классы DO только обёрнуты: env без служебных биндингов + метод __platformInspect.
import { CODEC_SOURCE } from "./codec";

export function platformModule(mainModule: string, doClasses: string[]): string {
  const main = JSON.stringify(`./${mainModule}`);
  const classWrappers = doClasses
    .map(
      (cls) => `
export class ${cls} extends (user.${cls} ?? missingClass(${JSON.stringify(cls)})) {
  constructor(ctx, env) { super(ctx, wrapEnv(env)); }
  __platformInspect() { return inspectStorage(this.ctx.storage); }
}`,
    )
    .join("\n");

  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import * as user from ${main};
export * from ${main};

function missingClass(name) {
  throw new Error("класс Durable Object " + name + " не экспортирован из главного модуля");
}
${CODEC_SOURCE}

// Данные объекта для панели: KV (storage.get/put), таблицы SQLite, будильник
const ROWS_LIMIT = 100;
async function inspectStorage(storage) {
  const kv = [];
  let kvTotal = 0;
  for (const [key, value] of await storage.list({ limit: ROWS_LIMIT })) kv.push({ key, value: preview(value) });
  const tables = [];
  if (storage.sql) {
    kvTotal = storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = '_cf_KV'").one().n
      ? storage.sql.exec("SELECT count(*) AS n FROM _cf_KV").one().n : kv.length;
    const names = storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).toArray().map((r) => r.name);
    for (const name of names) {
      const quoted = '"' + name.replace(/"/g, '""') + '"';
      const cursor = storage.sql.exec("SELECT * FROM " + quoted + " LIMIT " + ROWS_LIMIT);
      // строки в ячейках — как есть (без кавычек JSON), остальное — предпросмотром
      const cell = (v) => typeof v === "string" ? (v.length > 300 ? v.slice(0, 300) + "…" : v) : v === null ? "NULL" : preview(v, 300);
      const rows = cursor.toArray().map((row) => cursor.columnNames.map((c) => cell(row[c])));
      tables.push({
        name,
        columns: cursor.columnNames,
        rows,
        total: storage.sql.exec("SELECT count(*) AS n FROM " + quoted).one().n,
      });
    }
  } else kvTotal = kv.length;
  return { kv, kvTotal, tables, alarm: await storage.getAlarm() };
}

// Запрос от gateway: настоящий адрес — в x-platform-url
function restoreUrl(request) {
  const url = request.headers.get("x-platform-url");
  if (!url) return request;
  const restored = new Request(url, request);
  restored.headers.delete("x-platform-url");
  return restored;
}

class RemoteError extends Error {}

// env.<ИМЯ> другого воркера
function serviceStub(raw, entrypoint) {
  const ep = entrypoint ?? "";
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === "connect") return undefined;
      if (prop === "fetch") return (input, init) => {
        const request = new Request(input, init);
        request.headers.set("x-platform-entrypoint", ep);
        return raw.fetch(request);
      };
      return async (...args) => {
        const response = await raw.fetch("http://service/", {
          method: "POST",
          headers: { "content-type": "application/json", "x-platform-rpc": "1", "x-platform-entrypoint": ep },
          body: JSON.stringify({ method: prop, args: rpcEncode(args) }),
        });
        const text = await response.text();
        let result = null;
        try { result = JSON.parse(text); } catch {}
        // не JSON — ошибка платформы (цель не найдена, не отвечает, биндинг не объявлен)
        if (!result || typeof result !== "object") throw new Error(text || "RPC " + prop + ": HTTP " + response.status);
        if (!result.ok) {
          const error = new RemoteError(result.error?.message ?? "RPC error");
          error.name = result.error?.name ?? "Error";
          throw error;
        }
        return rpcDecode(result.value);
      };
    },
  });
}

const wrapped = new WeakMap();
function wrapEnv(env) {
  if (!env || typeof env !== "object") return env;
  let out = wrapped.get(env);
  if (out) return out;
  const services = env.__PLATFORM?.services ?? {};
  out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("__SVC_")) {
      const name = key.slice(6);
      out[name] = serviceStub(value, services[name] ?? null);
    } else if (!key.startsWith("__")) out[key] = value;
  }
  wrapped.set(env, out);
  return out;
}

const original = user.default;
let wrappedDefault;
if (typeof original === "function") {
  // class extends WorkerEntrypoint
  wrappedDefault = class extends original {
    constructor(ctx, env) { super(ctx, wrapEnv(env)); }
    fetch(request) { return super.fetch(restoreUrl(request)); }
  };
} else if (original && typeof original === "object") {
  // { fetch(request, env, ctx), scheduled(...), ... }
  wrappedDefault = {};
  for (const [key, value] of Object.entries(original)) {
    wrappedDefault[key] = typeof value === "function"
      ? (arg, env, ctx) => value.call(original, key === "fetch" ? restoreUrl(arg) : arg, wrapEnv(env), ctx)
      : value;
  }
}
export default wrappedDefault;

// Вход для service bindings (порт 8081). x-platform-entrypoint — имя класса
// WorkerEntrypoint или пусто (default), x-platform-rpc — вызов метода.
const FORBIDDEN = new Set(["constructor", "fetch", "connect", "tail", "trace", "scheduled", "queue", "email", "test", "alarm"]);
export class __PlatformEntry extends WorkerEntrypoint {
  #target(name) {
    const exported = name ? user[name] : user.default;
    if (typeof exported === "function") return { instance: new exported(this.ctx, wrapEnv(this.env)), handler: false };
    if (!name && exported && typeof exported === "object") return { instance: exported, handler: true };
    throw new Error(name ? "entrypoint " + name + " не экспортирован из главного модуля" : "у воркера нет default-экспорта");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__platform/health") return new Response("ok");
    if (url.pathname === "/__platform/do") return this.#inspect(request, url);
    const name = request.headers.get("x-platform-entrypoint") || null;

    if (request.headers.get("x-platform-rpc") === "1") {
      try {
        const { method, args: encoded } = await request.json();
        const args = rpcDecode(encoded);
        const { instance, handler } = this.#target(name);
        if (handler) throw new Error("RPC доступен только у класса WorkerEntrypoint (export default class extends WorkerEntrypoint)");
        if (typeof method !== "string" || method.startsWith("__") || FORBIDDEN.has(method) || method in Object.prototype
            || typeof instance[method] !== "function") {
          throw new TypeError("метод " + method + " не найден у entrypoint");
        }
        const value = await instance[method](...(Array.isArray(args) ? args : []));
        return Response.json({ ok: true, value: rpcEncode(value) });
      } catch (e) {
        return Response.json({ ok: false, error: { name: e?.name ?? "Error", message: e?.message ?? String(e) } });
      }
    }

    const forwarded = new Request(request);
    forwarded.headers.delete("x-platform-entrypoint");
    const { instance, handler } = this.#target(name);
    if (typeof instance.fetch !== "function") throw new Error("у entrypoint нет fetch()");
    return handler ? instance.fetch(forwarded, wrapEnv(this.env), this.ctx) : instance.fetch(forwarded);
  }

  // Панель: данные объекта. Только с токеном платформы для этого воркера.
  async #inspect(request, url) {
    const platform = this.env.__PLATFORM ?? {};
    if (!platform.admin || request.headers.get("x-platform-admin") !== platform.admin) {
      return new Response("forbidden", { status: 403 });
    }
    const binding = platform.doBindings?.[url.searchParams.get("class") ?? ""];
    const id = url.searchParams.get("id") ?? "";
    if (!binding || !/^[0-9a-f]{64}$/.test(id)) return new Response("not found", { status: 404 });
    try {
      const namespace = this.env[binding];
      const data = await namespace.get(namespace.idFromString(id)).__platformInspect();
      return Response.json(data);
    } catch (e) {
      return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  }
}
${classWrappers}
`;
}

/** tail-обработчик воркера: события в JSON → платформа → TailHub → wravler tail. */
export const TAIL_MODULE = `
const REDACTED = ["authorization", "cookie", "set-cookie", "proxy-authorization"];

function serialize(event, worker) {
  const json = JSON.parse(JSON.stringify(event, (key, value) =>
    key === "headers" && value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACTED.includes(k.toLowerCase()) ? "REDACTED" : v]))
      : value));
  json.scriptName = worker;
  if (json.entrypoint === "__PlatformEntry") delete json.entrypoint;
  return JSON.stringify(json);
}

// Пока tail никто не смотрит, платформа отвечает x-listeners: 0 — не шлём события LISTENERS_TTL_MS
const LISTENERS_TTL_MS = 2000;
let quietUntil = 0;

export default {
  async tail(events, env) {
    if (Date.now() < quietUntil) return;
    try {
      const response = await env.NET.fetch(env.PLATFORM + "/tail/" + env.WORKER, {
        method: "POST",
        headers: { authorization: "Bearer " + env.TOKEN, "content-type": "application/json" },
        body: JSON.stringify(events.map((e) => serialize(e, env.WORKER))),
      });
      if (response.headers.get("x-listeners") === "0") quietUntil = Date.now() + LISTENERS_TTL_MS;
    } catch {
      // платформа недоступна (перезапуск) — эти события теряются, как и в Cloudflare при обрыве tail
    }
  },
};
`;

/** env.ASSETS: запрос к статике этого воркера (файлы раздаёт платформа). */
export const ASSETS_MODULE = `
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("authorization", "Bearer " + env.TOKEN);
    const target = env.PLATFORM + "/assets/" + env.WORKER + url.pathname + url.search;
    // обрыв соединения до ответа (платформа пересоздана) — один повтор
    return env.NET.fetch(target, { method: request.method, headers })
      .catch(() => env.NET.fetch(target, { method: request.method, headers }));
  },
};
`;

/**
 * Service binding: запрос идёт через платформу (она знает текущий адрес цели и проверяет,
 * что биндинг объявлен). Цель задана в конфиге (TARGET), код воркера её не выбирает.
 * Обрыв соединения до ответа (платформа пересоздана) — один повтор.
 */
export const SERVICE_MODULE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("authorization", "Bearer " + env.TOKEN);
    const body = request.body ? await request.arrayBuffer() : null;
    const target = env.PLATFORM + "/service/" + env.WORKER + "/" + env.TARGET + url.pathname + url.search;
    const init = { method: request.method, headers, body, redirect: "manual" };
    try {
      return await env.NET.fetch(target, init);
    } catch {
      return env.NET.fetch(target, init);
    }
  },
};
`;
