# Workerd

Своя платформа для воркеров на [workerd](https://github.com/cloudflare/workerd), открытом рантайме Cloudflare Workers, без сети Cloudflare.
Воркеры деплоятся командой `wravler deploy`, это wrangler, направленный на нашу платформу. После деплоя воркер сразу доступен на `https://<имя>.workers.ava-kk.ru`.

## Как устроено

```
wravler deploy ──> api.workers.ava-kk.ru (воркер api, формат Cloudflare API /client/v4)
                     ├─> реестр (Durable Object на SQLite): воркеры, версии, код, vars, секреты
                     └─> оркестратор ──> контроллер (Docker) ──> контейнер worker-<имя>
                                                                  (свой процесс workerd)
запрос <имя>.workers.ava-kk.ru ──> Caddy ──> gateway ──> статика (сам gateway)
                                                  └──> worker-<имя>:8080 (по IP контейнера)
wravler tail ──WebSocket──> TailHub (DO на воркер) <── workerd:8081 <── tail-воркер в контейнере
```

- **Каждый воркер с кодом — отдельный контейнер со своим процессом workerd.** Бесконечный цикл, утечка памяти или падение одного воркера не задевают остальные. CPU и память ограничены Docker (`RUNNER_CPUS`, `RUNNER_MEMORY_MB` в `deploy/.env`).
- **Durable Objects нативные**: `durableObjectNamespaces` в конфиге контейнера, данные в `/data/workers/<имя>/`. Будильники, WebSocket Hibernation, RPC — как в workerd, без эмуляции.
- **Платформа** (`workerd-platform`) — один процесс с gateway, api, реестром, оркестратором и панелью. Пользовательского кода в нём нет.
- **Деплой**: api сохраняет версию в реестре, оркестратор собирает бандл (`config.capnp` + модули, `workers/api/src/runner/`), контроллер пересоздаёт контейнер `worker-<имя>`, оркестратор ждёт ответа. Не поднялась версия (ошибка при старте) — активной остаётся прежняя, а wrangler получает лог workerd:
  ```
  ✘ [ERROR] A request to the Cloudflare API (/accounts/ava/workers/scripts/hello) failed.
    версия 74 не запустилась:
    service hello: Uncaught Error: boom at startup
  ```
- **Сверка** раз в 15 с: контейнеры приводятся к реестру (нет, не та версия, старый образ движка — пересоздать; лишний — удалить). Контейнер, который **не отвечает** на проверку здоровья два раза подряд (завис), перезапускается. Проверено: воркер с `for(;;){}` поднимается сам через ~40 с, остальные в это время отвечают.
- **Первый запрос** к воркеру без контейнера (например, после восстановления из бэкапа) поднимает контейнер сам, запрос ждёт до 15 с.
- **Контроллер** — единственный компонент с доступом к Docker (`workers/controller`, тот же workerd). Он в отдельной сети `control`, куда кроме него входит только платформа, и принимает только токен платформы. Спецификацию контейнера (образ, пользователь, лимиты, сеть, volume) он задаёт сам: от платформы приходят только имя, версия и бандл.
- **`config.capnp` платформы статичный**, деплой воркеров платформу не перезапускает.
## Что поддерживается

| | |
|---|---|
| ES-модули (`export default { fetch }`) | ✅ |
| `[vars]` (текст и JSON) | ✅ |
| Секреты: `wravler secret put/list/delete/bulk`, `deploy --secrets-file`, панель | ✅ см. раздел «Секреты» |
| `wravler deploy`, `wravler delete` | ✅ |
| Веб-панель: воркеры, биндинги, версии и откат, живые логи, удаление | ✅ `panel.<ROOT_DOMAIN>` |
| `wravler tail` (логи, исключения, запросы) | ✅ фильтры (`--status`, `--method`…) пока игнорируются |
| Durable Objects своего воркера (SQLite и KV-API storage, RPC-методы, `fetch`) | ✅ см. раздел «Durable Objects» |
| DO другого воркера (`script_name`), миграции `renamed_classes` / `transferred_classes` | ❌ деплой отклоняется |
| Статика `[assets]`: с кодом и без, `env.ASSETS`, `404-page`, SPA | ✅ см. раздел «Статика» |
| `run_worker_first` со списком путей | ❌ деплой отклоняется (true/false поддерживается) |
| Service bindings `[[services]]`: `fetch`, RPC, именованные `entrypoint` | ✅ см. раздел «Service bindings» |
| `workers_dev = false` (воркер без адреса, только для других воркеров) | ✅ |
| KV, D1, R2, Queues | ❌ деплой отклоняется с понятной ошибкой |

## Структура

```
engine/      Dockerfile: движок (debian-slim + workerd) и образы platform/controller/egress поверх него
deploy/      compose.yaml, .env.example (сам .env не в git)
config/      config.capnp (платформа), controller.capnp, egress.capnp (выход в интернет)
backup/      образ бэкапа /data (sqlite3 + ротация)
workers/     воркеры платформы
  gateway/   <имя>.<ROOT_DOMAIN> → статика или контейнер воркера; internal.ts — вход для контейнеров
  api/       API для wravler, реестр (registry.ts), оркестратор (orchestrator.ts), статика, панель, tail
             runner/ — бандл контейнера: config.capnp, прослойка __platform.js, tar
  controller/ контейнеры worker-<имя> через Docker API (unix-сокет)
panel/       веб-панель: React + Vite, собирается в образ платформы
tools/
  wravler/   wrangler 4.141.0 с адресом и токеном нашей платформы
examples/    воркеры для проверки, деплоятся через wravler
  test/      тестовый воркер: страница с версией из [vars], /json, /echo, /error
  hello/
  counter/   Durable Object на SQLite: счётчик обращений по пути
  site/      статика + код: страницы из public/, /api/time, env.ASSETS, 404.html
  services/  API gateway + закрытый backend: service bindings, RPC, entrypoint, DO за биндингом
```

Образы (`engine/Dockerfile`, контекст сборки — корень репозитория):

| Образ | Что внутри |
|---|---|
| `engine` | только бинарник workerd, без кода и конфига |
| `workerd-platform` | engine + `config.capnp` + собранные `gateway/`, `api/` и панель в `/app` |
| `workerd-controller` | engine + `controller.capnp` + `controller/`. Он же образ контейнеров воркеров: их конфиг и код контроллер кладёт в `/app/runner` |
| `workerd-egress` | engine + `egress.capnp`, без JS |
| `workerd-backup` | debian-slim + sqlite3 + `backup/backup.sh` |

Volumes: `workerd_workerd_data` (`/data`: реестр `platform-Registry/`, статика `assets/`, данные DO воркеров `workers/<имя>/` — каждый контейнер видит только свой подкаталог) и `workerd_backups` (архивы бэкапа).

## Установка (один раз, в WSL-дистрибутиве `claude`)

```bash
sh tools/wravler/init-token.sh      # токен: ~/.config/wravler/token и deploy/.env
(cd tools/wravler && npm install) && npm install -g ./tools/wravler
DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml up -d --build
```

## Деплой воркера

```bash
cd examples/hello
wravler deploy            # → https://hello.workers.ava-kk.ru
wravler delete --name hello
```

wrangler в конце печатает адрес вида `hello.ava.workers.dev`: этот формат зашит в нём. Настоящий адрес `wravler` печатает строкой ниже.

## Durable Objects

В `wrangler.toml` всё как в Cloudflare:

```toml
[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Counter"]
```

В коде тоже: `env.COUNTER.getByName("x").hit()`, `env.COUNTER.get(env.COUNTER.idFromName("x"))`, `stub.fetch(request)`, `this.ctx.storage.sql` / `.get` / `.put`.

DO **нативные**: в конфиге контейнера воркера это `durableObjectNamespaces` (`uniqueKey = "<воркер>-<класс>"`, SQLite), всё работает так, как это реализует workerd: RPC-стабы, `stub.fetch()`, будильники (`setAlarm` / `alarm()`), WebSocket Hibernation API.

- Данные лежат в `/data/workers/<воркер>/<воркер>-<класс>/` и попадают в бэкап. Передеплой и перезапуск контейнера их не трогают. При удалении воркера они **не удаляются**: если снова задеплоить воркер с тем же именем, он найдёт свои данные.
- Не менять имя класса DO и имя воркера: от них зависит `uniqueKey`, а от него — id объектов и каталоги с данными.
- Данные DO времён Worker Loader (facets, `/data/platform-Host/`) в новую схему не переносятся: id объектов там считались иначе. Они остались на диске и в бэкапах.

**WebSocket**: клиент подключается к воркеру, воркер отдаёт запрос объекту через `stub.fetch(request)`, объект рассылает изменения всем подключённым.

При **деплое новой версии** воркера соединения рвутся (код `1006`), как и у Cloudflare, а данные объекта остаются. **Переподключаться должен клиент.** Браузерный `WebSocket` этого не умеет, обычно используют библиотеку вроде `partysocket` или `reconnecting-websocket`. Объекту стоит при подключении сразу отдавать текущее состояние.

## Service bindings

Один воркер вызывает другой внутри платформы — без выхода в интернет и без публичного адреса у цели. Так большой воркер делится на несколько, а один из них становится **API gateway**: единый вход с авторизацией, CORS и маршрутизацией, остальные закрыты. Пример — `examples/services/`.

```toml
# gateway/wrangler.toml
[[services]]
binding = "BACKEND"
service = "example-backend"

[[services]]
binding = "ADMIN"
service = "example-backend"
entrypoint = "Admin"          # именованный класс WorkerEntrypoint

# backend/wrangler.toml
workers_dev = false           # адреса <имя>.<домен> нет, только вызовы из других воркеров
```

```ts
await env.BACKEND.fetch(request);   // HTTP, как запрос по адресу воркера (включая статику)
await env.BACKEND.add(2, 3);        // RPC: у цели export default class extends WorkerEntrypoint
await env.ADMIN.stats("demo");      // RPC к именованному entrypoint
```

- Вызов всегда идёт в **активную версию** цели: после деплоя или отката вызываемого воркера вызывающие переходят на неё сами.
- Воркеры деплоятся в **любом порядке**. Если цели нет, вызов бросает `service binding A → B: воркер B не найден`.
- Связь **односторонняя**: воркер видит только те воркеры, что указаны в его `[[services]]`. Это проверяет платформа при каждом вызове.
- Логи вызываемого воркера (`console.*`, RPC, исключения) идут в **его** `wravler tail`.

Как устроено: воркеры в разных процессах, а RPC между процессами workerd не умеет. Поэтому прослойка `__platform.js` (главный модуль в контейнере, `workers/api/src/runner/modules.ts`) превращает служебный биндинг в `env.BACKEND` — JS `Proxy`: `fetch` уходит как HTTP, остальные методы — как RPC в JSON. Запрос идёт через платформу (`workerd:8081/service/<кто>/<кому>`): она проверяет токен контейнера и что биндинг объявлен, и пересылает на порт 8081 цели. Там его принимает `__PlatformEntry` прослойки: создаёт нужный entrypoint и вызывает метод.

Отличия от Cloudflare: аргументы и результаты RPC передаются как **JSON** — функции, стабы, `Date`, `Map`, `ReadableStream` не передаются. Ошибка у цели приходит как `Error` с тем же `name` и `message`. Чтение свойств через RPC (`await env.X.someProp`) и `connect()` не поддерживаются. Методы с именами на `__` недоступны.

## Секреты

Как в Cloudflare: в коде это обычное `env.ИМЯ`, рядом с `[vars]`.

```bash
wravler secret put API_TOKEN          # значение спросит (или из stdin: echo -n … | wravler secret put …)
wravler secret list
wravler secret delete API_TOKEN
wravler secret bulk secrets.json      # {"A": "…", "B": "…"}; null — удалить
```

Их можно добавить и удалить в панели («Настройки → Переменные и секреты»).

- **Изменение секрета — это новая версия** с тем же кодом: «Секрет API_TOKEN обновлён». Её видно во «Версиях», её можно откатить.
- **При деплое секреты наследуются** от предыдущей версии, задавать их заново не нужно. `wravler deploy --secrets-file` задаёт или обновляет их вместе с кодом.
- **Значения наружу не отдаются**: ни `secret list`, ни панель, ни API их не показывают, только имена.
- Имя секрета не может совпадать с переменной из `[vars]`, а префикс `__` занят платформой.
- `wravler secret put` для несуществующего воркера создаёт пустой воркер (так делает сам wrangler).

Хранятся секреты открытым текстом в реестре на сервере (`/data`) и попадают в бэкапы. Для своего сервера это нормально, но бэкапы стоит хранить так же аккуратно, как сами секреты.

## Статика

В `wrangler.toml` всё как в Cloudflare. Можно с кодом (`main`) или без него:

```toml
[assets]
directory = "./public"
binding = "ASSETS"                      # необязательно: env.ASSETS.fetch(request) из кода
not_found_handling = "404-page"         # или "single-page-application"
```

Порядок обработки запроса: сначала файл из статики, потом код воркера. Если кода нет, применяется `not_found_handling`. С `run_worker_first = true` сначала вызывается код, а статика ему доступна через `env.ASSETS`. Поиск по пути: `/about` → `about.html` или `about/index.html`, `/dir/` → `dir/index.html` (при `html_handling = "none"` — только точное совпадение). Файлы отдаются с правильным `Content-Type`, `ETag` = хэш, есть `304 Not Modified`.

Как устроено: при `wravler deploy` wrangler отправляет манифест «путь → хэш». api отвечает, каких файлов по хэшу у него ещё нет, и принимает только их (`api/src/assets.ts`). Поэтому повторный деплой без изменений ничего не загружает. Файлы лежат на диске по хэшу, `/data/assets/<2 символа>/<хэш>`, одинаковые файлы разных версий и воркеров хранятся один раз и попадают в бэкап. Манифест версии хранится в реестре. Gateway читает файлы через disk-сервис только для чтения.

Отличия от Cloudflare: нет редиректов `html_handling` (`/about.html` не перенаправляется на `/about`), не поддерживаются `_headers` и `_redirects`. Файлы, на которые больше не ссылается ни одна версия, пока не удаляются.

## Панель

`https://panel.<ROOT_DOMAIN>` (у нас `panel.workers.ava-kk.ru`) — React-приложение из `panel/`. Структура экранов повторяет дашборд Cloudflare для воркеров:

- **Список воркеров:** поиск, сортировка, значки «Закрытый», «Воркеры», «Durable Objects», «Статика», «Без кода», время последнего деплоя, меню «⋯» (открыть, версии, логи, удалить).
- **Страница воркера**, вкладки:
  - **Обзор** — адрес, биндинги (vars, секреты, DO, другие воркеры, статика), последние версии, сведения (главный модуль, compatibility date и флаги);
  - **Версии** — все версии; «Сделать активной» переключает воркер на выбранную версию сразу, без передеплоя (откат);
  - **Логи** — живой tail в браузере (тот же TailHub, что у `wravler tail`): запросы, статусы, `console.*`, исключения; пауза и очистка;
  - **Настройки** — модули кода, параметры статики, удаление с вводом имени.

Служебные `gateway` и `api` в реестре не хранятся, поэтому в списке их нет. Имя `panel` занято платформой.

Как устроено: панель собирается Vite внутри Docker (`engine/Dockerfile`, стадия `panel`) и кладётся в образ в `/app/panel`. Раздаёт её api-воркер через disk-сервис `panel-ui` (`workers/api/src/panel.ts`). Там же JSON-API под `/api/*`. Неизвестные пути отдают `index.html`: маршруты разбирает само приложение.

Вход по токену платформы (тот же, что у wravler). Сессия держится в cookie на 30 дней (`HttpOnly`, `Secure`, `SameSite=Strict`). Изменяющие запросы дополнительно требуют заголовок `X-Panel`, а у HTML-страницы есть CSP.

Разработка интерфейса: `cd panel && PANEL_API=<адрес API> npm run dev`.

## Живые логи

```bash
wravler tail test                  # console.*, исключения, статус каждого запроса
wravler tail test --format json    # полные события
```

Как это устроено: в контейнере воркера есть служебный tail-воркер (`tails = ["__tail"]` в его конфиге). Он переводит события в JSON и шлёт в платформу (`workerd:8081/tail/<имя>`, с токеном контейнера), оттуда они уходят в `TailHub`, это DO по одному на воркер, который держит WebSocket-сессии wrangler. Пока никто не смотрит tail, контейнер события не шлёт. Новая сессия начинает получать события не позже чем через 2 секунды.

Заголовки `authorization`, `cookie`, `set-cookie` и `proxy-authorization` в логах заменяются на `REDACTED`. На WebSocket wrangler токен не присылает, поэтому секретом служит id сессии: его выдаёт только `POST .../tails` по токену.

## Изоляция

- **Процесс и ресурсы.** Каждый воркер — свой контейнер и свой процесс workerd с лимитами CPU и памяти, `CapDrop: ALL`, `no-new-privileges`, пользователь без прав. Зависание или падение одного воркера на другие не влияет.
- **Данные.** Контейнер видит только свой подкаталог `/data/workers/<имя>` (монтируется подкаталог volume); реестр и чужие данные ему недоступны.
- **Биндинги работают в одну сторону** и проверяются платформой: воркер вызывает только те воркеры, что объявлены в его `[[services]]`. Внутренние запросы контейнера к платформе (tail, статика, service bindings) подписаны его токеном (HMAC от токена платформы и имени воркера): выдать себя за другой воркер он не может.
- **Сеть: только публичный интернет.** `fetch`, WebSocket и `connect()` из кода воркера идут через `egress` (`config/egress.capnp`: HTTP-прокси → `network` с `allow = ["public"]` и TLS). Приватные адреса — хост, LAN, соседние контейнеры, Caddy, другие воркеры — коду недоступны. Служебные воркеры контейнера ходят в частную сеть, но только на платформу, и коду пользователя этот сервис не выдаётся.
- **На уровне Docker: internal-сеть + egress.** Платформа и контейнеры воркеров сидят в `workerd_internal` (overlay, `--internal`): шлюза нет, маршрута к хосту, LAN и интернету нет (проверено: `ENETUNREACH`). Выход наружу есть только у egress, пользовательского кода в нём нет.
- **Docker** доступен только контроллеру (сеть `control`, токен). Контейнер воркера создаётся по фиксированной спецификации: образ, пользователь, лимиты, сеть и volume не зависят от того, что прислали в деплое.
- **Доступ к внутреннему** (база, сервис в LAN) давать точечно: отдельный вход в egress на один адрес и порт плюс биндинг только нужному воркеру. Не расширять `allow` у egress: тогда адрес станет доступен всем воркерам.

Список воркеров:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/wravler/token)" https://api.workers.ava-kk.ru/client/v4/accounts/ava/workers/scripts
```

## Деплой платформы

```bash
DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml up -d --build
```

Код платформы (TypeScript) собирается и проверяется внутри Docker, скриптов и `docker cp` нет. Платформа пересоздаётся за несколько секунд, контейнеры воркеров при этом продолжают работать. Если изменился образ движка (`workerd-controller`), сверка пересоздаёт контейнеры воркеров.

У платформы постоянный IP в `workerd_internal` (`PLATFORM_IP`, по умолчанию `10.0.3.250`). Контейнеры воркеров держат с ней соединения: пересозданная платформа на том же адресе сразу их сбрасывает, а на новом они висели бы до таймаута. По той же причине gateway ходит в контейнеры воркеров по IP (у нового контейнера новый адрес — и чистый пул соединений), а не по имени.

Контейнеры воркеров (`worker-<имя>`) создаёт контроллер, в `docker compose ps` их нет:

```bash
DOCKER_CONTEXT=manager docker ps --filter label=platform.worker
```

Настройки лежат в `deploy/.env` (в git не попадает, образец — `deploy/.env.example`). compose читает его сам при **любой** команде. Если `WRAVLER_TOKEN` пустой, compose откажется запускаться, поэтому поднять платформу с закрытым API случайно нельзя.

## Бэкап

Сервис `backup` раз в `BACKUP_INTERVAL_HOURS` (по умолчанию 24) снимает копию `/data` в `workerd-data-<время>.tar.gz` и хранит последние `BACKUP_KEEP` (по умолчанию 7). Первая копия делается сразу при старте. Базы SQLite копируются через `.backup`, это согласованный снимок даже во время записи. Куда класть архивы, задаёт `BACKUP_TARGET`: named volume (по умолчанию `workerd_backups`) или абсолютный путь на сервере, доступный на запись uid 10001.

Восстановление:

```bash
C="docker compose -f deploy/compose.yaml"            # DOCKER_CONTEXT=manager
$C stop workerd
docker rm -f $(docker ps -aq --filter label=platform.worker)   # контейнеры воркеров держат свои базы
docker run --rm -v workerd_workerd_data:/data -v workerd_workerd_backups:/b:ro --entrypoint sh workerd-backup:local \
  -c 'rm -rf /data/* && tar -xzf /b/workerd-data-<время>.tar.gz -C /data'
$C start workerd      # контейнеры воркеров поднимет сверка (или первый запрос)
```

Пока архивы лежат на том же сервере, что и данные, они спасают от ошибок и порчи базы, но не от потери сервера.

## Docker

Рабочий контекст — `manager`. compose сам контекст не выбирает, поэтому указывай его явно: `DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml ...`.

Bind mount с относительным путём (`./x:/y`) не работает, потому что демон удалённый. Можно использовать только абсолютный путь на сервере или named volume. Docker Hub недоступен, поэтому базовые образы берутся через `mirror.gcr.io` (аргумент `REGISTRY` в `engine/Dockerfile`).

## Caddy

Контейнер платформы подключён к внешней overlay-сети `workerd_internal` (`--internal --attachable`). Лейблы для caddy-docker-proxy отдают на него `ROOT_DOMAIN` и `*.ROOT_DOMAIN` из `deploy/.env` (у нас `workers.ava-kk.ru`). В DNS нужны обе записи. Gateway и api берут домен из той же переменной. Домен в wravler зашит отдельно.

В стеке Caddy для этого: `caddy-server` в сетях `caddy` и `workerd_internal`, у обоих сервисов `--ingress-networks=caddy,workerd_internal`. Управляющая сеть (`--controller-network`) остаётся `caddy`. Связь контейнеров внутри internal-сети работает, поэтому Caddy видит workerd.

Если сеть придётся пересоздать: `docker network create --driver overlay --internal --attachable --subnet 10.0.3.0/24 workerd_internal` (подсеть нужна для постоянного IP платформы). Сначала в сеть должен войти Caddy, потом workerd, иначе `*.workers.ava-kk.ru` перестанет открываться.

Wildcard-сертификат Caddy получает через DNS-01. Эта проверка уже включена в Caddy глобально (`acme_dns cloudflare {env.CF_API_TOKEN}`).
**Свой `caddy.tls.*` в лейблы не добавлять:** если блок невалидный, Caddy отклоняет весь новый конфиг, и перестают применяться изменения для всех сайтов.

На хост порты не публикуются: Caddy (сервис Swarm, может работать на другом узле) ходит к контейнеру через overlay-сеть `workerd_internal`.
