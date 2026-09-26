// Точка входа платформы: <имя>.workers.ava-kk.ru → воркер из реестра,
// загруженный на лету через Worker Loader. Новая версия = новый id загрузчика,
// поэтому деплой не требует перезапуска workerd и не трогает остальные воркеры.
import type { Registry, VersionCode } from "../../api/src/registry";
import { isValidWorkerName } from "../../api/src/names";

interface Env {
  ROOT_DOMAIN: string;
  API: Fetcher;
  LOADER: WorkerLoader;
  REGISTRY: DurableObjectNamespace<Registry>;
}

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

function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("main"));
}

export default {
  async fetch(request, env) {
    const host = new URL(request.url).hostname;
    const suffix = `.${env.ROOT_DOMAIN}`;

    if (!host.endsWith(suffix)) {
      return new Response("workerd platform", { status: 200 });
    }

    const name = host.slice(0, -suffix.length);
    // служебные поддомены: api (для wravler) и panel (веб-панель) живут в api-воркере
    if (name === "api" || name === "panel") return env.API.fetch(request);
    if (!isValidWorkerName(name)) return new Response("not found", { status: 404 });

    const version = await activeVersion(env, name);
    if (version === null) {
      return new Response(`unknown worker: ${name}`, { status: 404 });
    }

    try {
      const worker = env.LOADER.get(`${name}@${version}`, async () => {
        const code: VersionCode = await registry(env).code(version);
        return {
          ...(code as WorkerLoaderWorkerCode),
          // события воркера (console.*, исключения, запросы) → api.tail() → wravler tail
          tails: [env.API],
        };
      });
      return await worker.getEntrypoint().fetch(request);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`worker ${name}@${version} failed: ${message}`);
      return new Response(`worker ${name} failed: ${message}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
