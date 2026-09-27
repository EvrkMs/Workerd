// Точка входа платформы: <имя>.<ROOT_DOMAIN> → воркер из реестра,
// загруженный на лету через Worker Loader. Новая версия = новый id загрузчика,
// поэтому деплой не требует перезапуска workerd и не трогает остальные воркеры.
import { isValidWorkerName } from "../../api/src/names";
import { AssetsBinding } from "./assets";
import { DoAlarms, DoNamespace, Host } from "./durable";
import type { Env, PlatformExports } from "./loader";
import { workerRoute } from "./loader";
import { ServiceBinding, serveWorker } from "./services";
import { TailForwarder } from "./tail";

// ctx.exports и Durable Object namespace берут классы из главного модуля
export { AssetsBinding, DoAlarms, DoNamespace, Host, ServiceBinding, TailForwarder };

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
      const exports = (ctx as unknown as { exports: PlatformExports }).exports;
      return await serveWorker(env, exports, name, route.version, request);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`worker ${name}@${route.version} failed: ${message}`);
      return new Response(`worker ${name} failed: ${message}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
