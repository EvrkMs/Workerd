import type { TailIngest } from "../../api/src/index";
import type { Orchestrator } from "../../api/src/orchestrator";
import type { Registry } from "../../api/src/registry";

export interface Env {
  ROOT_DOMAIN: string;
  /** Токен платформы: из него выводятся токены контейнеров (runner/token.ts). */
  API_TOKEN?: string;
  API: Fetcher;
  TAIL: Service<TailIngest>;
  REGISTRY: DurableObjectNamespace<Registry>;
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  /** Сеть workerd_internal: контейнеры воркеров worker-<имя>. */
  RUNNERS: Fetcher;
  /** /data только для чтения: файлы статики */
  ASSET_FILES: Fetcher;
}

export function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
}

export function orchestrator(env: Env) {
  return env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("main"));
}
