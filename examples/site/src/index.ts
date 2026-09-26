// Код воркера вызывается только для путей, которых нет в статике (public/).
interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/time") {
      return Response.json({ now: new Date().toISOString() });
    }

    // Пример биндинга статики: отдать файл из public/ из кода
    if (url.pathname === "/api/logo") {
      return env.ASSETS.fetch(new Request(new URL("/logo.svg", url), request));
    }

    // Остальное — как решит статика (здесь это public/404.html)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
