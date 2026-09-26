// Заглушка Cloudflare API для wravler: пишет каждый запрос в лог (docker compose logs)
// и отвечает так, чтобы `wrangler deploy` дошёл до конца. Ничего не сохраняет и не деплоит.

const BODY_LIMIT = 4000;

function ok(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function notFound(code: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status: 404 },
  );
}

async function logRequest(request: Request, path: string): Promise<void> {
  const body = request.body ? await request.clone().text() : "";
  const shown = body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n...[${body.length} bytes]` : body;
  console.log(
    `### ${request.method} ${path}\ncontent-type: ${request.headers.get("content-type") ?? ""}\n${shown}`,
  );
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    await logRequest(request, path + url.search);

    const worker = path.match(/\/workers\/workers\/([^/]+)$/);
    if (worker && request.method === "GET") {
      return ok({
        name: worker[1],
        subdomain: { enabled: true, previews_enabled: false },
        url: `https://${worker[1]}.workers.ava-kk.ru`,
      });
    }
    if (request.method === "GET" && /\/workers\/services\/[^/]+$/.test(path)) {
      return notFound(10090, "workers.api.error.service_not_found");
    }
    if (request.method === "GET" && path.endsWith("/secrets")) return ok([]);
    if (path.endsWith("/workers/subdomain")) return ok({ subdomain: "ava" });
    if (path.endsWith("/deployments")) return ok({ deployments: [] });
    if (request.method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(path)) {
      return ok({ id: "stub", etag: "stub", has_modules: true });
    }
    return ok({});
  },
} satisfies ExportedHandler;
