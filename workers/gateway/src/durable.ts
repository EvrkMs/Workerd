// Durable Objects пользовательских воркеров.
//
// Каждый объект (<воркер>/<класс>/<id>) — отдельный Host-DO платформы. Внутри него
// класс пользователя запущен как facet со своей изолированной SQLite. Stub facet'а
// нельзя передать через RPC ("not serializable"), поэтому Host сам вызывает методы:
// call(метод, аргументы) и fetch(запрос).
//
// При деплое новой версии Host перезапускает facet с новым классом; данные остаются.
//
// Будильники: facet сам ставить их не может ("Facets currently cannot set alarms"),
// поэтому прослойка подменяет ctx.storage.setAlarm/getAlarm/deleteAlarm на вызовы
// DoAlarms → будильник ставится у Host, а Host.alarm() вызывает alarm() у facet.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DoAlarmsProps, DoNamespaceProps, Env, PlatformExports } from "./loader";
import { loadWorker, registry } from "./loader";

const OBJECT_ID = /^[0-9a-f]{1,512}$/;
const HOST_ID = /^[0-9a-f]{64}$/;

interface Owner {
  worker: string;
  className: string;
}

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

/**
 * Будильники объектов воркера (env.__ALARMS у загруженного воркера, использует прослойка).
 * hostId — ctx.id facet'а, он совпадает с id его Host. Host сверяет владельца: воркер
 * не может поставить будильник объекту чужого воркера, даже зная его id.
 */
export class DoAlarms extends WorkerEntrypoint<Env, DoAlarmsProps> {
  private host(hostId: string) {
    if (!HOST_ID.test(hostId)) throw new TypeError("Invalid Durable Object ID");
    return this.env.HOST.get(this.env.HOST.idFromString(hostId)) as unknown as DurableObjectStub<Host>;
  }

  set(hostId: string, scheduledTime: number): Promise<void> {
    return this.host(hostId).setHostAlarm(this.ctx.props.worker, scheduledTime) as Promise<void>;
  }

  get(hostId: string): Promise<number | null> {
    return this.host(hostId).getHostAlarm(this.ctx.props.worker) as Promise<number | null>;
  }

  delete(hostId: string): Promise<void> {
    return this.host(hostId).deleteHostAlarm(this.ctx.props.worker) as Promise<void>;
  }
}

export class Host extends DurableObject<Env> {
  private version: number | undefined;
  private ownerSaved = false;

  private async facet(worker: string, className: string, version: number) {
    this.version ??= (await this.ctx.storage.get<number>("version")) ?? undefined;
    // Запрос от старой версии (кэш в gateway) не должен откатить объект назад
    const target = Math.max(version, this.version ?? 0);
    if (this.version !== target) {
      if (this.version !== undefined) this.ctx.facets.abort(className, new Error("deployed a new version"));
      this.version = target;
      await this.ctx.storage.put("version", target);
    }
    // Владелец нужен будильникам; у объектов, созданных до их поддержки, его ещё нет
    if (!this.ownerSaved) {
      if (!(await this.ctx.storage.get<Owner>("owner"))) {
        await this.ctx.storage.put("owner", { worker, className } satisfies Owner);
      }
      this.ownerSaved = true;
    }
    const exports = (this.ctx as unknown as { exports: PlatformExports }).exports;
    const code = loadWorker(this.env, exports, worker, target);
    // id Host'а передаём facet'у: по нему прослойка находит этот Host для будильников
    return this.ctx.facets.get(className, () => ({ class: code.getDurableObjectClass(className), id: this.ctx.id }));
  }

  async call(worker: string, className: string, version: number, method: string, args: unknown[]): Promise<unknown> {
    if (method === "constructor" || method.startsWith("__platform")) throw new TypeError("not allowed");
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

  // --- будильники ------------------------------------------------------------------

  private async assertOwner(worker: string): Promise<void> {
    const owner = await this.ctx.storage.get<Owner>("owner");
    if (!owner || owner.worker !== worker) throw new Error("Durable Object belongs to another worker");
  }

  async setHostAlarm(worker: string, scheduledTime: number): Promise<void> {
    await this.assertOwner(worker);
    await this.ctx.storage.setAlarm(scheduledTime);
  }

  async getHostAlarm(worker: string): Promise<number | null> {
    await this.assertOwner(worker);
    return this.ctx.storage.getAlarm();
  }

  async deleteHostAlarm(worker: string): Promise<void> {
    await this.assertOwner(worker);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const owner = await this.ctx.storage.get<Owner>("owner");
    if (!owner) return;
    // Будильник исполняет актуальная версия воркера; если воркер удалён — последняя известная
    const active = await registry(this.env).activeVersion(owner.worker);
    const version = Math.max(active ?? 0, (await this.ctx.storage.get<number>("version")) ?? 0);
    const facet = (await this.facet(owner.worker, owner.className, version)) as unknown as {
      __platformAlarm(info: { retryCount: number; isRetry: boolean }): Promise<void>;
    };
    // AlarmInvocationInfo через RPC не передаётся — отдаём простой объект
    await facet.__platformAlarm({ retryCount: info?.retryCount ?? 0, isRetry: info?.isRetry ?? false });
  }
}
