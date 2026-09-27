// Точка входа платформы: <имя>.<ROOT_DOMAIN> → статика воркера (раздаёт сам gateway)
// или его код — в отдельном контейнере worker-<имя> со своим процессом workerd
// (контейнерами управляет оркестратор в api через контроллер).
import { isValidWorkerName } from "../../api/src/names";
import { RUNNER_HTTP_PORT } from "../../api/src/runner/bundle";
import { serveAsset, versionInfo } from "./assets";
import type { Env } from "./env";
import { orchestrator } from "./env";
import { Internal } from "./internal";
import { type WorkerRoute, workerRoute } from "./routes";

// Internal — вход для контейнеров воркеров (сокет :8081 в config.capnp)
export { Internal };

/** Сколько ждать контейнер, который (пере)запускается: деплой, падение, первый запрос. */
const START_WAIT_MS = 15_000;
const RETRY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Запрос в контейнер воркера. Настоящий адрес — в x-platform-url (прослойка в контейнере
 * восстанавливает request.url). Контейнер не отвечает — просим оркестратор поднять его
 * и повторяем (с новым адресом из реестра), пока не истечёт START_WAIT_MS.
 *
 * Контейнер адресуется по IP, а не по имени: пул соединений workerd привязан к хосту,
 * и соединение к пересозданному контейнеру (адрес исчез) висит до таймаута. Новый
 * контейнер — новый IP, значит и чистый пул.
 */
async function toRunner(env: Env, ctx: ExecutionContext, name: string, route: WorkerRoute, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) if (key.startsWith("x-platform-")) headers.delete(key);
  headers.set("x-platform-url", request.url);
  // тело читаем целиком: запрос может понадобиться повторить
  const body = request.body ? await request.arrayBuffer() : null;

  const deadline = Date.now() + START_WAIT_MS;
  let asked = false;
  let address = route.address;
  let lastError = "not started";
  for (;;) {
    if (address) {
      try {
        return await env.RUNNERS.fetch(`http://${address}:${RUNNER_HTTP_PORT}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (Date.now() > deadline) {
      return new Response(`worker ${name} is not running: ${lastError}`, { status: 503, headers: { "retry-after": "5" } });
    }
    if (!asked) {
      asked = true;
      ctx.waitUntil(orchestrator(env).ensure(name).catch((err: unknown) => console.error(`ensure ${name}: ${err}`)));
    }
    await sleep(RETRY_MS);
    address = (await workerRoute(env, name, true))?.address ?? null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const host = new URL(request.url).hostname;
    const suffix = `.${env.ROOT_DOMAIN}`;

    if (!host.endsWith(suffix)) {
      return new Response("workerd platform", { status: 200 });
    }

    const name = host.slice(0, -suffix.length);
    // служебные поддомены: api (для wravler) и panel (веб-панель) живут в api-воркере
    if (name === "api" || name === "panel") {
      // Тело читаем целиком: при пересылке потоком workerd пишет в лог
      // «Can't read from request stream after response», если api ответил раньше.
      const body = request.body ? await request.arrayBuffer() : null;
      return env.API.fetch(new Request(request, { body }));
    }
    if (!isValidWorkerName(name)) return new Response("not found", { status: 404 });

    const route = await workerRoute(env, name);
    // workers_dev = false: воркер доступен только через service bindings других воркеров
    if (!route || !route.public) {
      return new Response(`unknown worker: ${name}`, { status: 404 });
    }

    try {
      // Статика: сначала файл, потом код воркера (если нет run_worker_first)
      const info = await versionInfo(env, name, route.version);
      if (info.assets && !info.assets.config.run_worker_first) {
        const asset = await serveAsset(env, request, info.assets, info.hasCode);
        if (asset) return asset;
      }
      if (!info.hasCode) return new Response("not found", { status: 404 });
      return await toRunner(env, ctx, name, route, request);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`worker ${name}@${route.version} failed: ${message}`);
      return new Response(`worker ${name} failed: ${message}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
