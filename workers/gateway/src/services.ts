// Service bindings: вызов одного воркера платформы из другого ([[services]] в wrangler.toml).
//
// Воркер получает env.__SVC_<ИМЯ> = ServiceBinding с props {service, entrypoint}; прослойка
// превращает его в env.<ИМЯ>: fetch() → fetch-обработчик ниже, остальные методы → call().
// Цель ищется при каждом вызове (активная версия, кэш 1 с), поэтому после деплоя
// вызываемого воркера вызывающие переходят на новую версию сами, без своего деплоя.
// Вызов идёт внутри workerd — без сети и без публичного адреса у цели.
import { WorkerEntrypoint } from "cloudflare:workers";
import { serveAsset, versionInfo } from "./assets";
import type { Env, PlatformExports } from "./loader";
import { loadWorker, workerRoute } from "./loader";
import { PLATFORM_ENTRY } from "./shim";

export interface ServiceBindingProps {
  /** Кто вызывает — для сообщений об ошибках. */
  caller: string;
  service: string;
  /** Именованный entrypoint (класс WorkerEntrypoint); null — default-экспорт. */
  entrypoint: string | null;
}

/**
 * HTTP-запрос к воркеру — так же, как с <имя>.<домен>: статика, затем код.
 * Общее для gateway и service bindings.
 */
export async function serveWorker(
  env: Env,
  exports: PlatformExports,
  name: string,
  version: number,
  request: Request,
): Promise<Response> {
  const info = await versionInfo(env, name, version);
  if (info.assets && !info.assets.config.run_worker_first) {
    const asset = await serveAsset(env, request, info.assets, info.hasCode);
    if (asset) return asset;
  }
  if (!info.hasCode) return new Response("not found", { status: 404 });
  return loadWorker(env, exports, name, version).getEntrypoint().fetch(request);
}

type PlatformEntry = Fetcher & { call(method: string, args: unknown[]): Promise<unknown> };

export class ServiceBinding extends WorkerEntrypoint<Env, ServiceBindingProps> {
  private get platformExports(): PlatformExports {
    return (this.ctx as unknown as { exports: PlatformExports }).exports;
  }

  private async version(): Promise<number> {
    const { caller, service } = this.ctx.props;
    const route = await workerRoute(this.env, service);
    if (!route) throw new Error(`service binding ${caller} → ${service}: воркер ${service} не найден`);
    return route.version;
  }

  /** Вход в целевой воркер через прослойку: она создаёт нужный entrypoint с обёрнутым env. */
  private async entry(): Promise<PlatformEntry> {
    const { service, entrypoint } = this.ctx.props;
    const worker = loadWorker(this.env, this.platformExports, service, await this.version());
    return worker.getEntrypoint(PLATFORM_ENTRY, { props: { entrypoint } }) as unknown as PlatformEntry;
  }

  async fetch(request: Request): Promise<Response> {
    const { service, entrypoint } = this.ctx.props;
    // default-экспорт — как запрос по адресу воркера (со статикой); именованный — прямо в класс
    if (entrypoint === null) return serveWorker(this.env, this.platformExports, service, await this.version(), request);
    return (await this.entry()).fetch(request);
  }

  /** RPC: env.<ИМЯ>.method(...args) у вызывающего → method(...args) у цели. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    return (await this.entry()).call(method, args);
  }
}
