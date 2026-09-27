// API платформы в формате Cloudflare API (/client/v4) — ровно то подмножество,
// которое нужно `wravler deploy` / `wravler delete` / `wravler tail`.
// Код воркеров хранится в реестре (DO), живые логи идут через TailHub (DO).
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AssetConfig, DurableObjectBinding, ModuleType, ServiceBinding, UploadedModule, VersionAssets, WorkerMeta,
} from "./registry";
import { Registry } from "./registry";
import { TailHub } from "./tail";
import { handlePanel } from "./panel";
import { RESERVED_NAMES, isValidWorkerName } from "./names";
import { buckets, handleAssetUpload, parseManifest, parseSessionToken, sessionToken } from "./assets";

export { Registry, TailHub };

interface Env {
  API_TOKEN?: string;
  ROOT_DOMAIN: string;
  REGISTRY: DurableObjectNamespace<Registry>;
  TAILS: DurableObjectNamespace<TailHub>;
  /** /data на запись: сюда кладутся файлы статики (assets/<hh>/<hash>) */
  STORAGE: Fetcher;
  /** Собранная панель (panel/dist в образе, /app/panel) */
  PANEL_UI: Fetcher;
}

function tailHub(env: Env, name: string) {
  return env.TAILS.get(env.TAILS.idFromName(name));
}

// Кэш «у воркера есть слушатели tail», чтобы не ходить в TailHub на каждый запрос.
// Новая сессия начинает получать события не позже чем через LISTENERS_TTL_MS.
const LISTENERS_TTL_MS = 2000;
const listeners = new Map<string, { has: boolean; until: number }>();

async function hasListeners(env: Env, name: string): Promise<boolean> {
  const cached = listeners.get(name);
  if (cached && cached.until > Date.now()) return cached.has;
  const has = await tailHub(env, name).hasListeners();
  listeners.set(name, { has, until: Date.now() + LISTENERS_TTL_MS });
  return has;
}

function ok(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function fail(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
}

/** Общий обработчик изменения секретов: воркера нет → 10007 (wrangler тогда создаёт его сам). */
async function changeSecrets(
  env: Env,
  name: string,
  changes: Record<string, string | null>,
  result: () => unknown,
): Promise<Response> {
  try {
    const version = await registry(env).changeSecrets(name, changes);
    return version === null ? fail(404, 10007, `воркер ${name} не найден`) : ok(result());
  } catch (e) {
    return fail(400, 10021, e instanceof Error ? e.message : String(e));
  }
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
  bindings?: {
    name: string;
    type: string;
    text?: string;
    json?: unknown;
    class_name?: string;
    script_name?: string;
    service?: string;
    entrypoint?: string;
  }[];
  migrations?: {
    steps?: {
      renamed_classes?: unknown[];
      transferred_classes?: unknown[];
    }[];
  };
  annotations?: Record<string, string>;
  assets?: {
    jwt?: string;
    config?: Omit<AssetConfig, "run_worker_first"> & { run_worker_first?: boolean | string[] };
  };
}

/** Модуль-прослойка платформы, которую gateway подмешивает в код воркера. */
const PLATFORM_MODULE = "__platform.js";

const MODULE_TYPES: Record<string, ModuleType> = {
  "application/javascript+module": "js",
  "application/javascript": "cjs",
  "text/javascript": "cjs",
  "text/plain": "text",
  "application/json": "json",
  "application/octet-stream": "data",
  "application/wasm": "wasm",
};

type Parsed = { meta: WorkerMeta; modules: UploadedModule[]; assetSession: string | null } | { error: string };

/** Статика из metadata.assets: completion-jwt → манифест сессии загрузки. */
async function parseAssets(
  metadata: UploadMetadata,
  binding: string | undefined,
  workerName: string,
  env: Env,
): Promise<{ assets: VersionAssets; session: string } | { error: string } | null> {
  if (!metadata.assets?.jwt) {
    return binding ? { error: `биндинг ${binding} (assets): в загрузке нет статики` } : null;
  }
  const sessionId = parseSessionToken(metadata.assets.jwt, "complete");
  const session = sessionId ? await registry(env).assetSession(sessionId) : null;
  if (!sessionId || !session || session.worker !== workerName) {
    return { error: "сессия загрузки статики не найдена или истекла — запусти деплой ещё раз" };
  }
  if (session.missing > 0) return { error: `статика загружена не полностью: не хватает ${session.missing} файлов` };

  const config = metadata.assets.config ?? {};
  if (Array.isArray(config.run_worker_first)) {
    return { error: "run_worker_first со списком путей платформа пока не поддерживает (только true/false)" };
  }
  return {
    assets: {
      manifest: session.manifest,
      config: {
        html_handling: config.html_handling,
        not_found_handling: config.not_found_handling,
        run_worker_first: config.run_worker_first,
      },
      binding,
    },
    session: sessionId,
  };
}

async function parseUpload(request: Request, workerName: string, env: Env): Promise<Parsed> {
  const form = await request.formData();
  const rawMeta = form.get("metadata");
  if (typeof rawMeta !== "string") return { error: "в загрузке нет metadata" };
  const metadata = JSON.parse(rawMeta) as UploadMetadata;

  if (!metadata.main_module && !metadata.assets?.jwt) {
    return { error: "поддерживается только формат ES-модулей (export default { fetch })" };
  }

  const vars: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const durableObjects: DurableObjectBinding[] = [];
  const services: ServiceBinding[] = [];
  let assetsBinding: string | undefined;
  for (const b of metadata.bindings ?? []) {
    // имена "__…" заняты служебными биндингами платформы (__DO_…, __SVC_…, __ALARMS)
    if (b.name.startsWith("__")) return { error: `имя биндинга ${b.name}: префикс "__" занят платформой` };
    if (b.type === "plain_text") vars[b.name] = b.text;
    else if (b.type === "secret_text") secrets[b.name] = b.text ?? ""; // wrangler deploy --secrets-file
    else if (b.type === "assets") assetsBinding = b.name;
    else if (b.type === "json") vars[b.name] = b.json;
    else if (b.type === "durable_object_namespace") {
      if (b.script_name && b.script_name !== workerName) {
        return { error: `биндинг ${b.name}: DO другого воркера (${b.script_name}) платформа пока не поддерживает` };
      }
      if (!b.class_name || !/^[A-Za-z_$][\w$]*$/.test(b.class_name)) {
        return { error: `биндинг ${b.name}: некорректное имя класса DO` };
      }
      durableObjects.push({ binding: b.name, className: b.class_name });
    } else if (b.type === "service") {
      // Цель может ещё не существовать: воркеры деплоятся в любом порядке, ошибка — при вызове
      if (!b.service || !isValidWorkerName(b.service) || RESERVED_NAMES.has(b.service)) {
        return { error: `биндинг ${b.name}: некорректное имя воркера «${b.service ?? ""}»` };
      }
      if (b.entrypoint !== undefined && (!/^[A-Za-z_$][\w$]*$/.test(b.entrypoint) || b.entrypoint.startsWith("__"))) {
        return { error: `биндинг ${b.name}: некорректное имя entrypoint «${b.entrypoint}»` };
      }
      services.push({
        binding: b.name,
        service: b.service,
        ...(b.entrypoint && b.entrypoint !== "default" ? { entrypoint: b.entrypoint } : {}),
      });
    } else return { error: `биндинг ${b.name} (${b.type}) платформа пока не поддерживает` };
  }

  // Данные DO привязаны к имени класса, поэтому переименование/перенос классов
  // потеряли бы данные — не принимаем, пока это не реализовано явно.
  for (const step of metadata.migrations?.steps ?? []) {
    if (step.renamed_classes?.length || step.transferred_classes?.length) {
      return { error: "миграции renamed_classes/transferred_classes платформа пока не поддерживает" };
    }
  }

  const modules: UploadedModule[] = [];
  for (const [name, value] of form.entries()) {
    if (name === "metadata" || typeof value === "string") continue;
    if (name === PLATFORM_MODULE) return { error: `имя модуля ${PLATFORM_MODULE} занято платформой` };
    const contentType = value.type.split(";")[0].trim();
    if (contentType === "application/source-map") continue;
    const type = MODULE_TYPES[contentType];
    if (!type) return { error: `модуль ${name}: тип ${contentType} не поддерживается` };
    modules.push({ name, type, content: await value.arrayBuffer() });
  }

  const mainModule = metadata.main_module ?? "";
  if (mainModule && !modules.some((m) => m.name === mainModule)) {
    return { error: `главный модуль ${mainModule} не найден в загрузке` };
  }

  const assets = await parseAssets(metadata, assetsBinding, workerName, env);
  if (assets && "error" in assets) return assets;
  if (!mainModule && (durableObjects.length || services.length || Object.keys(vars).length)) {
    return { error: "биндинги без кода воркера (только статика) не имеют смысла — добавь main" };
  }

  return {
    meta: {
      mainModule,
      compatibilityDate: metadata.compatibility_date ?? "2026-09-01",
      compatibilityFlags: metadata.compatibility_flags ?? [],
      vars,
      durableObjects,
      ...(services.length ? { services } : {}),
      ...(Object.keys(secrets).length ? { secrets } : {}),
      ...(metadata.annotations?.["workers/message"] ? { message: metadata.annotations["workers/message"] } : {}),
      ...(assets ? { assets: assets.assets } : {}),
    },
    modules,
    assetSession: assets?.session ?? null,
  };
}

// --- маршруты ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    const response = await route(request, env);
    // Многие ответы не читают тело (например, POST .../subdomain {"enabled":true}).
    // Закрываем его явно — иначе workerd пишет в лог «Can't read from request stream».
    if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => {});
    return response;
  },
} satisfies ExportedHandler<Env>;

/**
 * События загруженных воркеров. У каждого воркера свой tail-обработчик в gateway
 * (TailForwarder с именем воркера в props) — так события без URL (RPC, Durable
 * Objects, вызовы через service binding) тоже попадают к нужному воркеру.
 */
export class TailIngest extends WorkerEntrypoint<Env> {
  async publish(worker: string, messages: string[]): Promise<void> {
    if (!isValidWorkerName(worker) || !messages.length) return;
    if (await hasListeners(this.env, worker)) await tailHub(this.env, worker).publish(messages);
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Веб-панель: panel.<ROOT_DOMAIN> (вход по тому же токену, своя сессия в cookie)
  if (url.hostname === `panel.${env.ROOT_DOMAIN}`) {
    return handlePanel(request, env);
  }

  // WebSocket wrangler tail: /tail/<воркер>/<сессия>. Токен wrangler сюда не шлёт,
  // секрет — сам id сессии, который выдаётся только по токену (POST .../tails).
  const tailSocket = url.pathname.match(/^\/tail\/([^/]+)\/([0-9a-f-]{36})$/);
  if (tailSocket) {
    const [, name, id] = tailSocket;
    // только заголовки: у upgrade-запроса нет тела, а проброс потока даёт ошибку после 101
    return tailHub(env, name).fetch(`http://tail/connect?id=${id}`, { headers: request.headers });
  }

  // Загрузка файлов статики: авторизация jwt-сессией (её выдаёт assets-upload-session по токену)
  if (request.method === "POST" && /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/.test(url.pathname)) {
    const result = await handleAssetUpload(request, registry(env), env.STORAGE);
    return result.error ? fail(result.status, 10000, result.error) : ok({ jwt: result.jwt });
  }

  if (!authorized(request, env)) {
    return fail(401, 10000, "Authentication error: неверный или отсутствующий токен");
  }

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

  // Статика, шаг 1: манифест → какие файлы (по хэшу) ещё не загружены
  if (method === "POST" && rest.startsWith("scripts/") && sub === "assets-upload-session") {
    const body = (await request.json().catch(() => null)) as { manifest?: unknown } | null;
    const manifest = parseManifest(body?.manifest);
    if ("error" in manifest) return fail(400, 10021, String(manifest.error));
    const session = await registry(env).startAssetSession(name, manifest);
    // Всё уже есть на диске → сразу completion-jwt, wrangler пропустит загрузку
    return ok({
      jwt: sessionToken(session.missing.length ? "upload" : "complete", session.id),
      buckets: buckets(session.missing),
    });
  }

  // Загрузка кода: PUT /scripts/:name
  if (method === "PUT" && rest.startsWith("scripts/") && sub === "") {
    const parsed = await parseUpload(request, name, env);
    if ("error" in parsed) return fail(400, 10021, parsed.error);
    let version: number;
    try {
      version = await registry(env).deploy(name, parsed.meta, parsed.modules);
    } catch (e) {
      return fail(400, 10021, e instanceof Error ? e.message : String(e));
    }
    if (parsed.assetSession) await registry(env).endAssetSession(parsed.assetSession);
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
    const route = await registry(env).route(name);
    return ok({
      name,
      subdomain: { enabled: route?.public ?? true, previews_enabled: false },
      url: `https://${name}.${env.ROOT_DOMAIN}`,
    });
  }

  // wrangler tail: создать сессию → WebSocket-адрес, удалить сессию при выходе
  if (method === "POST" && sub === "tails") {
    if ((await registry(env).activeVersion(name)) === null) {
      return fail(404, 10007, `воркер ${name} не найден`);
    }
    const session = await tailHub(env, name).createSession();
    listeners.delete(name);
    return ok({
      id: session.id,
      url: `wss://api.${env.ROOT_DOMAIN}/tail/${name}/${session.id}`,
      expires_at: session.expiresAt,
    });
  }
  const tailSession = sub.match(/^tails\/([0-9a-f-]{36})$/);
  if (method === "DELETE" && tailSession) {
    await tailHub(env, name).deleteSession(tailSession[1]);
    return ok(null);
  }
  if (method === "GET" && sub === "tails") return ok([]);

  // Секреты: wrangler secret list / put / delete / bulk. Значения наружу не отдаются.
  if (method === "GET" && sub === "secrets") {
    const names = (await registry(env).secretNames(name)) ?? [];
    return ok(names.map((secret) => ({ name: secret, type: "secret_text" })));
  }
  if (method === "PUT" && sub === "secrets") {
    const body = (await request.json().catch(() => null)) as { name?: string; text?: string } | null;
    if (!body?.name || typeof body.text !== "string") return fail(400, 10021, "нужны name и text");
    return changeSecrets(env, name, { [body.name]: body.text }, () => ({ name: body.name, type: "secret_text" }));
  }
  const secretPath = sub.match(/^secrets\/(.+)$/);
  if (method === "DELETE" && secretPath) {
    const key = decodeURIComponent(secretPath[1]);
    if (!(await registry(env).secretNames(name))?.includes(key)) return fail(404, 10056, `секрет ${key} не найден`);
    return changeSecrets(env, name, { [key]: null }, () => null);
  }
  if (method === "PATCH" && sub === "secrets-bulk") {
    const body = (await request.json().catch(() => null)) as { secrets?: Record<string, { text?: string } | null> } | null;
    const changes: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(body?.secrets ?? {})) changes[key] = value === null ? null : String(value.text ?? "");
    return changeSecrets(env, name, changes, () => ({}));
  }
  if (method === "GET" && sub === "deployments") return ok({ deployments: [] });
  if (sub === "settings") return ok({});

  // workers_dev: wrangler после деплоя шлёт POST {"enabled": true|false}.
  // false — у воркера нет адреса <имя>.<домен>, до него достают только service bindings.
  if (sub === "subdomain") {
    if (method === "POST") {
      const body = (await request.json().catch(() => null)) as { enabled?: boolean } | null;
      const enabled = body?.enabled !== false;
      if (!(await registry(env).setPublic(name, enabled))) return fail(404, 10007, `воркер ${name} не найден`);
      return ok({ enabled, previews_enabled: false });
    }
    const route = await registry(env).route(name);
    return ok({ enabled: route?.public ?? true, previews_enabled: false });
  }

  return fail(404, 7003, `unknown route ${method} ${url.pathname}`);
}
