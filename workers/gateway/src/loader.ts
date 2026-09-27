// Загрузка воркера из реестра через Worker Loader. Один и тот же id (<имя>@<версия>)
// используют gateway (запросы), Host-DO (классы Durable Objects) и service bindings,
// поэтому код и env собираются здесь, в одном месте.
import type { TailIngest } from "../../api/src/index";
import type { Registry, VersionCode } from "../../api/src/registry";
import type { AssetsBinding, AssetsProps } from "./assets";
import type { DoAlarms, DoNamespace } from "./durable";
import type { ServiceBinding, ServiceBindingProps } from "./services";
import type { TailForwarder, TailForwarderProps } from "./tail";
import { PLATFORM_MODULE, shimModule } from "./shim";

export interface Env {
  ROOT_DOMAIN: string;
  API: Fetcher;
  TAIL: Service<TailIngest>;
  LOADER: WorkerLoader;
  REGISTRY: DurableObjectNamespace<Registry>;
  HOST: DurableObjectNamespace;
  /** /data только для чтения: файлы статики */
  ASSET_FILES: Fetcher;
}

export interface DoNamespaceProps {
  worker: string;
  className: string;
  version: number;
}

export interface DoAlarmsProps {
  worker: string;
}

/** ctx.exports платформы: нужен, чтобы выдать воркеру биндинги с props. */
export interface PlatformExports {
  DoNamespace(options: { props: DoNamespaceProps }): Service<DoNamespace>;
  DoAlarms(options: { props: DoAlarmsProps }): Service<DoAlarms>;
  AssetsBinding(options: { props: AssetsProps }): Service<AssetsBinding>;
  ServiceBinding(options: { props: ServiceBindingProps }): Service<ServiceBinding>;
  TailForwarder(options: { props: TailForwarderProps }): Service<TailForwarder>;
}

/**
 * Лимит CPU на один вызов воркера (как у Cloudflare Workers на платном тарифе).
 * ВНИМАНИЕ: workerd 1.20260926 его не соблюдает — бесконечный цикл вешает весь процесс
 * (проверено). Оставлено на случай, если поддержку добавят; защита — снаружи.
 */
const WORKER_CPU_MS = 30_000;

export function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
}

// Кэш «имя → активная версия», чтобы не ходить в реестр на каждый запрос.
// После деплоя новая версия начинает отвечать не позже чем через ROUTE_TTL_MS.
const ROUTE_TTL_MS = 1000;
const routes = new Map<string, { route: WorkerRoute | null; until: number }>();

export interface WorkerRoute {
  version: number;
  /** false — workers_dev = false: адреса <имя>.<домен> нет, только service bindings. */
  public: boolean;
}

export async function workerRoute(env: Env, name: string): Promise<WorkerRoute | null> {
  const cached = routes.get(name);
  if (cached && cached.until > Date.now()) return cached.route;
  const route = await registry(env).route(name);
  routes.set(name, { route, until: Date.now() + ROUTE_TTL_MS });
  return route;
}

export function loadWorker(env: Env, exports: PlatformExports, name: string, version: number): WorkerStub {
  return env.LOADER.get(`${name}@${version}`, async () => {
    const code: VersionCode = await registry(env).code(version);

    const workerEnv: Record<string, unknown> = { ...code.env };
    for (const d of code.durableObjects) {
      workerEnv[`__DO_${d.binding}`] = exports.DoNamespace({
        props: { worker: name, className: d.className, version },
      });
    }
    if (code.durableObjects.length) {
      // будильники объектов (прослойка подменяет ими ctx.storage.setAlarm и т.д.)
      workerEnv.__ALARMS = exports.DoAlarms({ props: { worker: name } });
    }
    for (const s of code.services) {
      // прослойка превращает __SVC_<ИМЯ> в env.<ИМЯ> с fetch() и RPC-методами
      workerEnv[`__SVC_${s.binding}`] = exports.ServiceBinding({
        props: { caller: name, service: s.service, entrypoint: s.entrypoint ?? null },
      });
    }
    if (code.assetsBinding) {
      workerEnv[code.assetsBinding] = exports.AssetsBinding({ props: { worker: name, version } });
    }

    return {
      compatibilityDate: code.compatibilityDate,
      compatibilityFlags: code.compatibilityFlags,
      mainModule: PLATFORM_MODULE,
      modules: {
        ...code.modules,
        [PLATFORM_MODULE]: { js: shimModule(code.mainModule, code.durableObjects.map((d) => d.className)) },
      },
      env: workerEnv,
      // зависший код (бесконечный цикл) не должен занимать CPU бесконечно
      limits: { cpuMs: WORKER_CPU_MS },
      // события воркера (console.*, исключения, запросы, RPC, DO) → wravler tail
      tails: [exports.TailForwarder({ props: { worker: name } })],
    } as WorkerLoaderWorkerCode;
  });
}
