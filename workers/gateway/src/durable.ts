// Durable Objects пользовательских воркеров.
//
// Каждый объект (<воркер>/<класс>/<id>) — отдельный Host-DO платформы. Внутри него
// класс пользователя запущен как facet со своей изолированной SQLite. Stub facet'а
// нельзя передать через RPC ("not serializable"), поэтому Host сам вызывает методы:
// call(метод, аргументы) и fetch(запрос).
//
// При деплое новой версии Host перезапускает facet с новым классом; данные остаются.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DoNamespaceProps, Env, PlatformExports } from "./loader";
import { loadWorker } from "./loader";

const OBJECT_ID = /^[0-9a-f]{1,512}$/;

/** Биндинг env.<ИМЯ> у загруженного воркера (оборачивается прослойкой в Namespace). */
export class DoNamespace extends WorkerEntrypoint<Env, DoNamespaceProps> {
  private host(idHex: string) {
    if (!OBJECT_ID.test(idHex)) throw new TypeError("Invalid Durable Object ID");
    const { worker, className } = this.ctx.props;
    return this.env.HOST.get(this.env.HOST.idFromName(`${worker}/${className}/${idHex}`)) as unknown as DurableObjectStub<Host>;
  }

  call(idHex: string, method: string, args: unknown[]): Promise<unknown> {
    const { worker, className, version } = this.ctx.props;
    return this.host(idHex).call(worker, className, version, method, args) as Promise<unknown>;
  }

  fetchObject(idHex: string, request: Request): Promise<Response> {
    const { worker, className, version } = this.ctx.props;
    const headers = new Headers(request.headers);
    headers.set("x-platform-worker", worker);
    headers.set("x-platform-class", className);
    headers.set("x-platform-version", String(version));
    return this.host(idHex).fetch(new Request(request, { headers }));
  }
}

export class Host extends DurableObject<Env> {
  private version: number | undefined;

  private async facet(worker: string, className: string, version: number) {
    this.version ??= (await this.ctx.storage.get<number>("version")) ?? undefined;
    // Запрос от старой версии (кэш в gateway) не должен откатить объект назад
    const target = Math.max(version, this.version ?? 0);
    if (this.version !== target) {
      if (this.version !== undefined) this.ctx.facets.abort(className, new Error("deployed a new version"));
      this.version = target;
      await this.ctx.storage.put("version", target);
    }
    const exports = (this.ctx as unknown as { exports: PlatformExports }).exports;
    const code = loadWorker(this.env, exports, worker, target);
    return this.ctx.facets.get(className, () => ({ class: code.getDurableObjectClass(className) }));
  }

  async call(worker: string, className: string, version: number, method: string, args: unknown[]): Promise<unknown> {
    if (method === "constructor") throw new TypeError("not allowed");
    const facet = (await this.facet(worker, className, version)) as unknown as Record<string, (...a: unknown[]) => unknown>;
    return facet[method](...args);
  }

  async fetch(request: Request): Promise<Response> {
    const worker = request.headers.get("x-platform-worker") ?? "";
    const className = request.headers.get("x-platform-class") ?? "";
    const version = Number(request.headers.get("x-platform-version"));
    const headers = new Headers(request.headers);
    for (const h of ["x-platform-worker", "x-platform-class", "x-platform-version"]) headers.delete(h);
    const facet = await this.facet(worker, className, version);
    return facet.fetch(new Request(request, { headers }));
  }
}
