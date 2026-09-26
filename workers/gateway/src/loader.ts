// Загрузка воркера из реестра через Worker Loader. Один и тот же id (<имя>@<версия>)
// используют и gateway (запросы), и Host-DO (классы Durable Objects), поэтому код
// и env собираются здесь, в одном месте.
import type { Registry, VersionCode } from "../../api/src/registry";
import type { AssetsBinding, AssetsProps } from "./assets";
import type { DoAlarms, DoNamespace } from "./durable";
import { PLATFORM_MODULE, shimModule } from "./shim";

export interface Env {
  ROOT_DOMAIN: string;
  API: Fetcher;
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

/** ctx.exports платформы: нужен, чтобы выдать воркеру биндинг DoNamespace с props. */
export interface PlatformExports {
  DoNamespace(options: { props: DoNamespaceProps }): Service<DoNamespace>;
  DoAlarms(options: { props: DoAlarmsProps }): Service<DoAlarms>;
  AssetsBinding(options: { props: AssetsProps }): Service<AssetsBinding>;
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
      // события воркера (console.*, исключения, запросы) → api.tail() → wravler tail
      tails: [env.API],
    } as WorkerLoaderWorkerCode;
  });
}
