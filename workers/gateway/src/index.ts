// Точка входа платформы: <имя>.<ROOT_DOMAIN> → воркер из реестра,
// загруженный на лету через Worker Loader. Новая версия = новый id загрузчика,
// поэтому деплой не требует перезапуска workerd и не трогает остальные воркеры.
import { isValidWorkerName } from "../../api/src/names";
import { AssetsBinding, serveAsset, versionInfo } from "./assets";
import { DoAlarms, DoNamespace, Host } from "./durable";
import type { Env, PlatformExports } from "./loader";
import { loadWorker, registry } from "./loader";

// ctx.exports и Durable Object namespace берут классы из главного модуля
export { AssetsBinding, DoAlarms, DoNamespace, Host };

// Кэш «имя → активная версия», чтобы не ходить в реестр на каждый запрос.
// После деплоя новая версия начинает отвечать не позже чем через VERSION_TTL_MS.
const VERSION_TTL_MS = 1000;
const versions = new Map<string, { version: number | null; until: number }>();

async function activeVersion(env: Env, name: string): Promise<number | null> {
  const cached = versions.get(name);
  if (cached && cached.until > Date.now()) return cached.version;
  const version = await registry(env).activeVersion(name);
  versions.set(name, { version, until: Date.now() + VERSION_TTL_MS });
  return version;
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

    const version = await activeVersion(env, name);
    if (version === null) {
      return new Response(`unknown worker: ${name}`, { status: 404 });
    }

    try {
      // Статика: сначала файл, потом код воркера (если нет run_worker_first)
      const info = await versionInfo(env, name, version);
      if (info.assets && !info.assets.config.run_worker_first) {
        const asset = await serveAsset(env, request, info.assets, info.hasCode);
        if (asset) return asset;
      }
      if (!info.hasCode) return new Response("not found", { status: 404 });

      const exports = (ctx as unknown as { exports: PlatformExports }).exports;
      return await loadWorker(env, exports, name, version).getEntrypoint().fetch(request);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`worker ${name}@${version} failed: ${message}`);
      return new Response(`worker ${name} failed: ${message}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
