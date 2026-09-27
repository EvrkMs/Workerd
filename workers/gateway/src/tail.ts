// tail-обработчик загруженных воркеров. У каждого воркера свой экземпляр (имя в props),
// поэтому события без URL — RPC, Durable Objects, вызовы через service binding —
// тоже доходят до `wravler tail` нужного воркера.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./loader";

export interface TailForwarderProps {
  worker: string;
}

/** Заголовки посетителей, которые не должны попадать в логи. */
const REDACTED_HEADERS = ["authorization", "cookie", "set-cookie", "proxy-authorization"];

/** Событие в JSON для wrangler (протокол trace-v1), без секретных заголовков посетителя. */
function serializeEvent(event: TraceItem, worker: string): string {
  const json = JSON.parse(
    JSON.stringify(event, (key, value) =>
      key === "headers" && value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, string>).map(([k, v]) => [
              k,
              REDACTED_HEADERS.includes(k.toLowerCase()) ? "REDACTED" : v,
            ]),
          )
        : value,
    ),
  ) as { scriptName?: string | null };
  // у загруженных воркеров scriptName пустой — подставляем имя
  json.scriptName ||= worker;
  return JSON.stringify(json);
}

export class TailForwarder extends WorkerEntrypoint<Env, TailForwarderProps> {
  async tail(events: TraceItem[]): Promise<void> {
    const { worker } = this.ctx.props;
    await this.env.TAIL.publish(worker, events.map((e) => serializeEvent(e, worker)));
  }
}
