// Бандл контейнера воркера: config.capnp для workerd + модули кода + значения биндингов.
// Контроллер распаковывает его в /app/runner контейнера worker-<имя> (образ движка).
//
// Внутри контейнера:
//   :8080 — HTTP воркера (сюда шлёт gateway платформы)
//   :8081 — __PlatformEntry: service bindings других воркеров и проверка здоровья
//   /data — подкаталог workers/<имя> volume платформы: SQLite его Durable Objects
// Наружу — через egress (только публичные адреса), к платформе — workerd:8081
// (туда же service bindings: платформа знает текущий адрес цели и проверяет биндинг).
import type { RunnerSource } from "../registry";
import { ASSETS_MODULE, SERVICE_MODULE, TAIL_MODULE, platformModule } from "./modules";

export const RUNNER_HTTP_PORT = 8080;
export const RUNNER_INTERNAL_PORT = 8081;

const MODULE_KIND: Record<string, string> = {
  js: "esModule",
  cjs: "commonJsModule",
  text: "text",
  data: "data",
  json: "json",
  wasm: "wasm",
};

/** Строка Cap'n Proto: управляющие символы не допускаем, кавычки и \ экранируем. */
function str(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`недопустимый символ в «${value}»`);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * token — токен контейнера (его запросы к платформе), admin — токен платформы
 * (её запросы в контейнер: просмотр данных DO из панели).
 */
export function buildBundle(
  worker: string,
  token: string,
  admin: string,
  src: RunnerSource,
): Record<string, Uint8Array | string> {
  const files: Record<string, Uint8Array | string> = {};
  const workerModules: string[] = [];

  files["p/platform.js"] = platformModule(src.mainModule, src.durableObjects.map((d) => d.className));
  workerModules.push(`(name = "__platform.js", esModule = embed "p/platform.js")`);
  src.modules.forEach((m, i) => {
    const path = `w/${i}`;
    files[path] = new Uint8Array(m.content);
    workerModules.push(`(name = ${str(m.name)}, ${MODULE_KIND[m.type]} = embed ${str(path)})`);
  });

  // Значения переменных и секретов — файлами (embed): так не нужно экранировать содержимое
  const bindings: string[] = [];
  let n = 0;
  for (const [name, value] of Object.entries(src.vars)) {
    const path = `b/${n++}`;
    if (typeof value === "string") {
      files[path] = value;
      bindings.push(`(name = ${str(name)}, text = embed ${str(path)})`);
    } else {
      files[path] = JSON.stringify(value);
      bindings.push(`(name = ${str(name)}, json = embed ${str(path)})`);
    }
  }
  for (const [name, value] of Object.entries(src.secrets)) {
    const path = `b/${n++}`;
    files[path] = value;
    bindings.push(`(name = ${str(name)}, text = embed ${str(path)})`);
  }
  for (const d of src.durableObjects) {
    bindings.push(`(name = ${str(d.binding)}, durableObjectNamespace = ${str(d.className)})`);
  }

  const services: string[] = [
    `(name = ${str(worker)}, worker = .main)`,
    `(name = "__tail", worker = .tail)`,
    // Частная сеть (платформа, другие воркеры) — только для служебных воркеров ниже,
    // у каждого фиксированная цель; коду пользователя этот сервис не выдаётся.
    // network, а не external: имя разрешается на каждый запрос (контейнеры меняют IP).
    `(name = "__net", network = (allow = ["private"]))`,
    // выход наружу для fetch()/connect() — только через egress (публичные адреса)
    `(name = "internet", external = (address = "egress:8080", http = (style = proxy)))`,
  ];
  const extraWorkers: string[] = [];

  // Service bindings: служебный воркер, который ходит только на порт 8081 цели (__PlatformEntry)
  const serviceEntrypoints: Record<string, string | null> = {};
  const targets = new Set<string>();
  for (const s of src.services) {
    targets.add(s.service);
    serviceEntrypoints[s.binding] = s.entrypoint ?? null;
    bindings.push(`(name = ${str(`__SVC_${s.binding}`)}, service = ${str(`__svc_${s.service}`)})`);
  }
  if (targets.size) files["p/service.js"] = SERVICE_MODULE;
  [...targets].forEach((target, i) => {
    services.push(`(name = ${str(`__svc_${target}`)}, worker = .svc${i})`);
    extraWorkers.push(platformWorker(`svc${i}`, "p/service.js", worker, token, `(name = "TARGET", text = ${str(target)}),`));
  });
  files["b/platform.json"] = JSON.stringify({
    services: serviceEntrypoints,
    admin,
    doBindings: Object.fromEntries(src.durableObjects.map((d) => [d.className, d.binding])),
  });
  bindings.push(`(name = "__PLATFORM", json = embed "b/platform.json")`);

  let assetsWorker = "";
  if (src.assetsBinding) {
    services.push(`(name = "__assets", worker = .assets)`);
    bindings.push(`(name = ${str(src.assetsBinding)}, service = "__assets")`);
    files["p/assets.js"] = ASSETS_MODULE;
    assetsWorker = platformWorker("assets", "p/assets.js", worker, token);
  }

  let storage = "";
  if (src.durableObjects.length) {
    services.push(`(name = "__data", disk = (path = "/data", writable = true))`);
    // uniqueKey не менять: от него зависят id объектов и каталоги с их данными
    const namespaces = src.durableObjects
      .map((d) => `(className = ${str(d.className)}, uniqueKey = ${str(`${worker}-${d.className}`)}, enableSql = true)`)
      .join(",\n    ");
    storage = `
  durableObjectNamespaces = [
    ${namespaces}
  ],
  durableObjectStorage = (localDisk = "__data"),`;
  }

  files["p/tail.js"] = TAIL_MODULE;

  files["config.capnp"] = `# Сгенерировано платформой для воркера ${worker}. Не редактировать.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ${services.join(",\n    ")}
  ],
  sockets = [
    (name = "http", address = "*:${RUNNER_HTTP_PORT}", http = (), service = ${str(worker)}),
    (name = "internal", address = "*:${RUNNER_INTERNAL_PORT}", http = (), service = (name = ${str(worker)}, entrypoint = "__PlatformEntry")),
  ],
);

const main :Workerd.Worker = (
  modules = [
    ${workerModules.join(",\n    ")}
  ],
  compatibilityDate = ${str(src.compatibilityDate)},
  compatibilityFlags = [${src.compatibilityFlags.map(str).join(", ")}],
  bindings = [
    ${bindings.join(",\n    ")}
  ],${storage}
  tails = ["__tail"],
);

${platformWorker("tail", "p/tail.js", worker, token)}
${assetsWorker}
${extraWorkers.join("\n")}
`;
  return files;
}

/** Служебный воркер контейнера: знает имя воркера и его токен, ходит только в платформу. */
function platformWorker(name: string, path: string, worker: string, token: string, extra = ""): string {
  return `const ${name} :Workerd.Worker = (
  modules = [ (name = "${name}.js", esModule = embed "${path}") ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "NET", service = "__net"),
    (name = "PLATFORM", text = "http://workerd:8081"),
    (name = "WORKER", text = ${str(worker)}),
    (name = "TOKEN", text = ${str(token)}),${extra}
  ],
);`;
}
