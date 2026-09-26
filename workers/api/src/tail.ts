// Живые логи воркеров для `wravler tail`.
//
// gateway передаёт api-воркер в `tails` при загрузке каждого воркера → workerd вызывает
// tail() у api с событиями (TraceItem). api раскладывает их по TailHub — один DO на воркер,
// который держит WebSocket-сессии wrangler и рассылает им события как есть (протокол trace-v1).
import { DurableObject } from "cloudflare:workers";

/** Сколько живёт сессия, если wrangler не закрыл её сам. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Заголовки посетителей, которые не должны попадать в логи. */
const REDACTED_HEADERS = ["authorization", "cookie", "set-cookie", "proxy-authorization"];

export class TailHub extends DurableObject<object> {
  /** Создаёт сессию; её id — секрет в WebSocket-адресе (wrangler не шлёт на WS токен). */
  async createSession(): Promise<{ id: string; expiresAt: string }> {
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await this.ctx.storage.put(`session:${id}`, expiresAt);
    return { id, expiresAt: new Date(expiresAt).toISOString() };
  }

  async deleteSession(id: string): Promise<void> {
    await this.ctx.storage.delete(`session:${id}`);
    for (const ws of this.ctx.getWebSockets(id)) ws.close(1000, "tail deleted");
  }

  /** WebSocket-подключение wrangler: /connect?id=<сессия> */
  async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const expiresAt = await this.ctx.storage.get<number>(`session:${id}`);
    if (!expiresAt || expiresAt < Date.now()) {
      return new Response("tail session not found or expired", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [id]);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "trace-v1" },
    });
  }

  hasListeners(): boolean {
    return this.ctx.getWebSockets().length > 0;
  }

  publish(messages: string[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      for (const message of messages) {
        try {
          ws.send(message);
        } catch {
          // сокет уже закрывается — пропускаем
        }
      }
    }
  }

  // wrangler при подключении шлёт {"debug": false} — нам нечего с этим делать
  webSocketMessage(): void {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // wrangler не переподключается — закрытый сокет означает конец сессии
    for (const tag of this.ctx.getTags(ws)) await this.ctx.storage.delete(`session:${tag}`);
    // 1005/1006 (обрыв, Ctrl+C) — служебные коды, отправлять их обратно нельзя
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // сокет уже закрыт
    }
  }
}

/** Имя воркера по событию: scriptName у загруженных воркеров пустой, берём из хоста. */
export function workerFromEvent(event: TraceItem, rootDomain: string): string | null {
  if (event.scriptName) return event.scriptName;
  const request = (event.event as TraceItemFetchEventInfo | null)?.request;
  if (!request) return null;
  const host = new URL(request.url).hostname;
  const suffix = `.${rootDomain}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

/** Событие в JSON для wrangler, без секретных заголовков посетителя. */
export function serializeEvent(event: TraceItem): string {
  return JSON.stringify(event, (key, value) =>
    key === "headers" && value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, string>).map(([k, v]) => [
            k,
            REDACTED_HEADERS.includes(k.toLowerCase()) ? "REDACTED" : v,
          ]),
        )
      : value,
  );
}
