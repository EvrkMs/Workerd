// Внутренний вход платформы (workerd:8081, сеть workerd_internal) для контейнеров
// воркеров. Снаружи (через Caddy) сюда не попасть: Caddy ходит только на :8080.
//
//   POST /tail/<воркер>                    — события tail → TailHub (wravler tail, панель)
//   GET  /assets/<воркер>/<путь>           — env.ASSETS: статика активной версии воркера
//   *    /service/<воркер>/<цель>/<путь>   — service binding: запрос в контейнер цели (:8081)
//
// Каждый запрос подписан токеном контейнера (HMAC от токена платформы и имени воркера),
// поэтому контейнер одного воркера не может выдать себя за другой. Service binding
// пропускается, только если у активной версии воркера он действительно объявлен.
import { WorkerEntrypoint } from "cloudflare:workers";
import { isValidWorkerName } from "../../api/src/names";
import { RUNNER_INTERNAL_PORT } from "../../api/src/runner/bundle";
import { runnerToken, sameToken } from "../../api/src/runner/token";
import { serveAsset, versionInfo } from "./assets";
import type { Env } from "./env";
import { orchestrator, registry } from "./env";
import { workerRoute } from "./routes";

const tokens = new Map<string, Promise<string>>();

function expectedToken(env: Env, worker: string): Promise<string> {
  let token = tokens.get(worker);
  if (!token) {
    token = runnerToken(env.API_TOKEN ?? "", worker);
    tokens.set(worker, token);
  }
  return token;
}

/** Сколько ждать цель service binding, если её контейнер (пере)запускается. */
const SERVICE_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Internal extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/(tail|assets|service)\/([^/]+)(\/.*)?$/);
    if (!match || !isValidWorkerName(match[2]) || !this.env.API_TOKEN) return new Response("not found", { status: 404 });
    const [, kind, worker, path = "/"] = match;

    const auth = request.headers.get("authorization") ?? "";
    if (!sameToken(auth, `Bearer ${await expectedToken(this.env, worker)}`)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (kind === "tail" && request.method === "POST") {
      const messages = (await request.json().catch(() => null)) as unknown;
      if (!Array.isArray(messages) || !messages.every((m) => typeof m === "string")) {
        return new Response("bad request", { status: 400 });
      }
      const listening = await this.env.TAIL.publish(worker, messages);
      return new Response(null, { status: 204, headers: { "x-listeners": listening ? "1" : "0" } });
    }

    const headers = new Headers(request.headers);
    headers.delete("authorization");

    if (kind === "assets") {
      const route = await workerRoute(this.env, worker);
      const info = route && (await versionInfo(this.env, worker, route.version));
      if (!info?.assets) return new Response("not found", { status: 404 });
      const assetRequest = new Request(`http://${worker}${path}${url.search}`, { method: request.method, headers });
      return (await serveAsset(this.env, assetRequest, info.assets, false))!;
    }

    if (kind === "service") {
      const service = path.match(/^\/([^/]+)(\/.*)?$/);
      if (!service || !isValidWorkerName(service[1])) return new Response("not found", { status: 404 });
      const [, target, rest = "/"] = service;
      // служебные пути цели (просмотр данных DO и т.п.) другим воркерам недоступны
      if (rest.startsWith("/__platform/")) return new Response("forbidden", { status: 403 });
      return this.service(worker, target, `${rest}${url.search}`, request, headers);
    }

    return new Response("not found", { status: 404 });
  }

  /** Запрос caller → target: только если биндинг объявлен; цель по IP (как в gateway). */
  private async service(caller: string, target: string, path: string, request: Request, headers: Headers): Promise<Response> {
    const body = request.body ? await request.arrayBuffer() : null;
    const deadline = Date.now() + SERVICE_WAIT_MS;
    let asked = false;
    let lastError = "not started";
    for (;;) {
      const { allowed, address } = await registry(this.env).serviceTarget(caller, target);
      if (!allowed) {
        return new Response(`service binding ${caller} → ${target} не объявлен`, { status: 403 });
      }
      if (address) {
        try {
          return await this.env.RUNNERS.fetch(`http://${address}:${RUNNER_INTERNAL_PORT}${path}`, {
            method: request.method,
            headers,
            body,
            redirect: "manual",
          });
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      } else if ((await registry(this.env).activeVersion(target)) === null) {
        return new Response(`service binding ${caller} → ${target}: воркер ${target} не найден`, { status: 502 });
      }
      if (Date.now() > deadline) {
        return new Response(`service binding ${caller} → ${target}: воркер не отвечает (${lastError})`, { status: 503 });
      }
      if (!asked) {
        asked = true;
        this.ctx.waitUntil(orchestrator(this.env).ensure(target).catch(() => {}));
      }
      await sleep(250);
    }
  }
}
