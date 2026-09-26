// API платформы в формате Cloudflare API (/client/v4) — ровно то подмножество,
// которое нужно `wravler deploy` / `wravler delete`. Код воркеров хранится в реестре (DO).
import type { ModuleType, UploadedModule, WorkerMeta } from "./registry";
import { Registry } from "./registry";
import { RESERVED_NAMES, isValidWorkerName } from "./names";

export { Registry };

interface Env {
  API_TOKEN?: string;
  ROOT_DOMAIN: string;
  REGISTRY: DurableObjectNamespace<Registry>;
}

function ok(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function fail(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
}

function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
}

function authorized(request: Request, env: Env): boolean {
  // Без токена в окружении API закрыт полностью.
  if (!env.API_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

// --- загрузка воркера -------------------------------------------------------

interface UploadMetadata {
  main_module?: string;
  body_part?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings?: { name: string; type: string; text?: string; json?: unknown }[];
}

const MODULE_TYPES: Record<string, ModuleType> = {
  "application/javascript+module": "js",
  "application/javascript": "cjs",
  "text/javascript": "cjs",
  "text/plain": "text",
  "application/json": "json",
  "application/octet-stream": "data",
  "application/wasm": "wasm",
};

type Parsed = { meta: WorkerMeta; modules: UploadedModule[] } | { error: string };

async function parseUpload(request: Request): Promise<Parsed> {
  const form = await request.formData();
  const rawMeta = form.get("metadata");
  if (typeof rawMeta !== "string") return { error: "в загрузке нет metadata" };
  const metadata = JSON.parse(rawMeta) as UploadMetadata;

  if (!metadata.main_module) {
    return { error: "поддерживается только формат ES-модулей (export default { fetch })" };
  }

  const vars: Record<string, unknown> = {};
  for (const b of metadata.bindings ?? []) {
    if (b.type === "plain_text") vars[b.name] = b.text;
    else if (b.type === "json") vars[b.name] = b.json;
    else return { error: `биндинг ${b.name} (${b.type}) платформа пока не поддерживает` };
  }

  const modules: UploadedModule[] = [];
  for (const [name, value] of form.entries()) {
    if (name === "metadata" || typeof value === "string") continue;
    const contentType = value.type.split(";")[0].trim();
    if (contentType === "application/source-map") continue;
    const type = MODULE_TYPES[contentType];
    if (!type) return { error: `модуль ${name}: тип ${contentType} не поддерживается` };
    modules.push({ name, type, content: await value.arrayBuffer() });
  }

  if (!modules.some((m) => m.name === metadata.main_module)) {
    return { error: `главный модуль ${metadata.main_module} не найден в загрузке` };
  }

  return {
    meta: {
      mainModule: metadata.main_module,
      compatibilityDate: metadata.compatibility_date ?? "2026-09-01",
      compatibilityFlags: metadata.compatibility_flags ?? [],
      vars,
    },
    modules,
  };
}

// --- маршруты ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) {
      return fail(401, 10000, "Authentication error: неверный или отсутствующий токен");
    }

    const url = new URL(request.url);

    // wrangler delete после удаления ищет KV от старого Workers Sites — KV у нас нет
    if (request.method === "GET" && /^\/client\/v4\/accounts\/[^/]+\/storage\/kv\/namespaces$/.test(url.pathname)) {
      return Response.json({
        success: true, errors: [], messages: [], result: [],
        result_info: { page: 1, per_page: 100, count: 0, total_count: 0 },
      });
    }

    const route = url.pathname.match(/^\/client\/v4\/accounts\/[^/]+\/workers\/(.*)$/);
    if (!route) return fail(404, 7003, `unknown route ${url.pathname}`);
    const rest = route[1];
    const method = request.method;

    // Список воркеров (для себя и будущей панели)
    if (method === "GET" && rest === "scripts") {
      return ok(await registry(env).list());
    }

    if (rest === "subdomain") return ok({ subdomain: "ava" });

    const script = rest.match(/^(?:scripts|services|workers)\/([^/]+)(?:\/(.*))?$/);
    if (!script) return fail(404, 7003, `unknown route ${url.pathname}`);
    const [, name, sub = ""] = script;

    if (!isValidWorkerName(name)) {
      return fail(400, 10016, `имя «${name}»: только a-z, 0-9 и дефис, до 63 символов (это поддомен)`);
    }
    if (RESERVED_NAMES.has(name)) {
      return fail(400, 10016, `имя «${name}» занято платформой`);
    }

    // Загрузка кода: PUT /scripts/:name
    if (method === "PUT" && rest.startsWith("scripts/") && sub === "") {
      const parsed = await parseUpload(request);
      if ("error" in parsed) return fail(400, 10021, parsed.error);
      const version = await registry(env).deploy(name, parsed.meta, parsed.modules);
      // wrangler показывает deployment_id как UUID без дефисов → кодируем в него номер версии
      const deploymentId = version.toString(16).padStart(32, "0");
      return ok({ id: name, etag: deploymentId, deployment_id: deploymentId, has_modules: true });
    }

    // Удаление: wrangler delete шлёт DELETE /services/:name
    if (method === "DELETE" && sub === "" && (rest.startsWith("services/") || rest.startsWith("scripts/"))) {
      const existed = await registry(env).remove(name);
      return existed ? ok({ id: name }) : fail(404, 10007, `воркер ${name} не найден`);
    }

    // Состояние воркера. wrangler всегда считает воркер «новым» — так он не
    // сравнивает конфиг с «дашбордом», которого у нас нет.
    if (method === "GET" && rest.startsWith("services/") && sub === "") {
      return fail(404, 10090, "workers.api.error.service_not_found");
    }
    if (method === "GET" && rest.startsWith("workers/") && sub === "") {
      return ok({
        name,
        subdomain: { enabled: true, previews_enabled: false },
        url: `https://${name}.${env.ROOT_DOMAIN}`,
      });
    }

    if (method === "GET" && sub === "secrets") return ok([]);
    if (method === "GET" && sub === "deployments") return ok({ deployments: [] });
    if (sub === "settings") return ok({});
    if (sub === "subdomain") return ok({ enabled: true, previews_enabled: false });

    return fail(404, 7003, `unknown route ${method} ${url.pathname}`);
  },
} satisfies ExportedHandler<Env>;
