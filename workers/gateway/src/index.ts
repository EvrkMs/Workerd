// Точка входа платформы: <имя>.workers.ava-kk.ru → service binding с тем же именем.
// Воркеры подключаются биндингами в config.capnp; переменные окружения — в UPPER_CASE,
// поэтому они никогда не совпадут с именем воркера.

interface Env {
  ROOT_DOMAIN: string;
  [binding: string]: unknown;
}

const WORKER_NAME = /^[a-z0-9-]+$/;

export default {
  async fetch(request, env) {
    const host = new URL(request.url).hostname;
    const suffix = `.${env.ROOT_DOMAIN}`;

    if (!host.endsWith(suffix)) {
      return new Response("workerd platform", { status: 200 });
    }

    const name = host.slice(0, -suffix.length);
    const target = WORKER_NAME.test(name) ? (env[name] as Fetcher | undefined) : undefined;
    if (!target) {
      return new Response(`unknown worker: ${name}`, { status: 404 });
    }

    return target.fetch(request);
  },
} satisfies ExportedHandler<Env>;
