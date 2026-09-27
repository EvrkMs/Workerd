import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject {
  async hit(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }

  async count(): Promise<number> {
    return (await this.ctx.storage.get<number>("n")) ?? 0;
  }
}

/** Основной вход: env.BACKEND у gateway. */
export default class Backend extends WorkerEntrypoint<Env> {
  // HTTP: env.BACKEND.fetch(request)
  async fetch(request: Request): Promise<Response> {
    return Response.json({ from: "example-backend", path: new URL(request.url).pathname });
  }

  // RPC: await env.BACKEND.add(2, 3)
  add(a: number, b: number): number {
    console.log(`add(${a}, ${b})`);
    return a + b;
  }

  async hit(name: string): Promise<number> {
    return this.env.COUNTER.getByName(name).hit();
  }
}

/** Именованный entrypoint: [[services]] ... entrypoint = "Admin". */
export class Admin extends WorkerEntrypoint<Env> {
  async stats(name: string): Promise<{ name: string; hits: number }> {
    // тот же объект, что у Backend.hit — это один воркер
    return { name, hits: await this.env.COUNTER.getByName(name).count() };
  }
}
