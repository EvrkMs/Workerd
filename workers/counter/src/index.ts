// Тестовый Durable Object: счётчик обращений по пути, хранится в SQLite объекта.
// Нужен, чтобы проверить, что данные DO переживают перезапуск и пересоздание контейнера.
import { DurableObject } from "cloudflare:workers";

interface Env {
  COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS hits (path TEXT PRIMARY KEY, count INTEGER NOT NULL)",
      );
    });
  }

  hit(path: string): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `INSERT INTO hits (path, count) VALUES (?, 1)
         ON CONFLICT (path) DO UPDATE SET count = count + 1
         RETURNING count`,
        path,
      )
      .one().count;
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const counter = env.COUNTER.get(env.COUNTER.idFromName("main"));
    const count = await counter.hit(path);
    return Response.json({ path, count });
  },
} satisfies ExportedHandler<Env>;
