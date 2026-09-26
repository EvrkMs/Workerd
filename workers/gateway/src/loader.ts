// Загрузка воркера из реестра через Worker Loader. Один и тот же id (<имя>@<версия>)
// используют и gateway (запросы), и Host-DO (классы Durable Objects), поэтому код
// и env собираются здесь, в одном месте.
import type { Registry, VersionCode } from "../../api/src/registry";
import type { DoNamespace } from "./durable";
import { PLATFORM_MODULE, shimModule } from "./shim";

export interface Env {
  ROOT_DOMAIN: string;
  API: Fetcher;
  LOADER: WorkerLoader;
  REGISTRY: DurableObjectNamespace<Registry>;
  HOST: DurableObjectNamespace;
}

export interface DoNamespaceProps {
  worker: string;
  className: string;
  version: number;
}

/** ctx.exports платформы: нужен, чтобы выдать воркеру биндинг DoNamespace с props. */
export interface PlatformExports {
  DoNamespace(options: { props: DoNamespaceProps }): Service<DoNamespace>;
}

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

    return {
      compatibilityDate: code.compatibilityDate,
      compatibilityFlags: code.compatibilityFlags,
      mainModule: PLATFORM_MODULE,
      modules: {
        ...code.modules,
        [PLATFORM_MODULE]: { js: shimModule(code.mainModule, code.durableObjects.map((d) => d.className)) },
      },
      env: workerEnv,
      // события воркера (console.*, исключения, запросы) → api.tail() → wravler tail
      tails: [env.API],
    } as WorkerLoaderWorkerCode;
  });
}
