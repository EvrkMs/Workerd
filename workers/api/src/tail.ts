// Живые логи воркеров для `wravler tail`.
//
// gateway при загрузке каждого воркера передаёт в `tails` свой TailForwarder (с именем
// воркера) → события (TraceItem) в JSON → api TailIngest.publish() → TailHub — один DO
// на воркер, который держит WebSocket-сессии wrangler и рассылает им события (протокол trace-v1).
import { DurableObject } from "cloudflare:workers";

/** Сколько живёт сессия, если wrangler не закрыл её сам. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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
