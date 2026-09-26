// Тестовый воркер: показывает, какая версия сейчас задеплоена и что приходит в запросе.
//   /       — страница с версией и сообщением из [vars]
//   /json   — то же в JSON
//   /echo   — метод, путь и заголовки запроса

interface Env {
  VERSION: string;
  MESSAGE: string;
}

// Метка изолята: меняется при каждом новом деплое (новая версия = новый изолят).
// Задаётся при первом запросе: на верхнем уровне модуля часы в Workers стоят на нуле.
let isolate: { id: string; since: string } | undefined;

function info(request: Request, env: Env) {
  isolate ??= { id: crypto.randomUUID().slice(0, 8), since: new Date().toISOString() };
  return {
    worker: "test",
    version: env.VERSION,
    message: env.MESSAGE,
    isolate: isolate.id,
    isolateSince: isolate.since,
    now: new Date().toISOString(),
    path: new URL(request.url).pathname,
  };
}

function page(data: ReturnType<typeof info>): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>test · workerd</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    .version { display: inline-block; background: #222; color: #fff; border-radius: .4rem; padding: .1rem .6rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
    dt { color: #777; }
    code { background: #f2f2f2; padding: .1rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>${escape(data.message)}</h1>
  <p>Версия <span class="version">${escape(data.version)}</span></p>
  <dl>
    <dt>Изолят</dt><dd><code>${data.isolate}</code> с ${data.isolateSince}</dd>
    <dt>Сейчас</dt><dd>${data.now}</dd>
  </dl>
  <p>Ещё: <a href="/json"><code>/json</code></a>, <a href="/echo"><code>/echo</code></a></p>
</body>
</html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/json") {
      return Response.json(info(request, env));
    }

    if (url.pathname === "/echo") {
      return Response.json({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
      });
    }

    return new Response(page(info(request, env)), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
