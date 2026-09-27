import type { Admin, default as Backend } from "../backend/index";

interface Env {
  BACKEND: Service<Backend>;
  ADMIN: Service<Admin>;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // здесь же — общая авторизация, CORS, лимиты и т.п. для всех внутренних воркеров
    if (url.pathname === "/rpc") return Response.json({ sum: await env.BACKEND.add(2, 3) });
    if (url.pathname === "/hit") return Response.json({ hits: await env.BACKEND.hit("demo") });
    if (url.pathname === "/admin") return Response.json(await env.ADMIN.stats("demo"));
    if (url.pathname.startsWith("/backend/")) return env.BACKEND.fetch(request);
    return new Response("example-gateway: /rpc, /hit, /admin, /backend/<путь>\n");
  },
} satisfies ExportedHandler<Env>;
