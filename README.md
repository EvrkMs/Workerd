# Workerd

Своя платформа для воркеров на [workerd](https://github.com/cloudflare/workerd), открытом рантайме Cloudflare Workers, без сети Cloudflare.
Воркеры деплоятся командой `wravler deploy`, это wrangler, направленный на нашу платформу. После деплоя воркер сразу доступен на `https://<имя>.workers.ava-kk.ru`.

## Как устроено

```
wravler deploy ──> api.workers.ava-kk.ru (воркер api, формат Cloudflare API /client/v4)
                     └─> реестр (Durable Object на SQLite): воркеры, версии, код, vars

запрос <имя>.workers.ava-kk.ru ──> gateway ──> реестр: активная версия <имя>
                                     └─> Worker Loader: LOADER.get("<имя>@<версия>", код) → fetch
                                              │ console.*, исключения, запросы (tails)
wravler tail ──WebSocket──> TailHub (DO на воркер) <──── api.tail()
```

- **`config.capnp` статичный.** При деплое воркеров он не меняется, workerd не перезапускается, остальные воркеры не затрагиваются.
- **Новая версия** — это новый id в Worker Loader. После деплоя она начинает отвечать не позже чем через 1 секунду (кэш версии в gateway).
- **Ошибка в коде воркера** даёт 500 только ему, остальные продолжают работать.
- **Worker Loader экспериментальный**, поэтому workerd запускается с `--experimental`, а у gateway стоит `compatibilityFlags = ["experimental"]`. Версию workerd обновлять осознанно и с проверкой.

## Что поддерживается

| | |
|---|---|
| ES-модули (`export default { fetch }`) | ✅ |
| `[vars]` (текст и JSON) | ✅ |
| `wravler deploy`, `wravler delete` | ✅ |
| Веб-панель: список воркеров, удаление | ✅ `panel.<ROOT_DOMAIN>` |
| `wravler tail` (логи, исключения, запросы) | ✅ фильтры (`--status`, `--method`…) пока игнорируются |
| Durable Objects, service bindings, KV, D1, R2, секреты | ❌ деплой отклоняется с понятной ошибкой |

## Структура

```
engine/      Dockerfile: движок (debian-slim + workerd) и образы platform/egress поверх него
deploy/      compose.yaml, .env.example (сам .env не в git)
config/      config.capnp (платформа), egress.capnp (выход в интернет)
backup/      образ бэкапа /data (sqlite3 + ротация)
workers/     воркеры платформы
  gateway/   <имя>.workers.ava-kk.ru → воркер из реестра через Worker Loader
  api/       API для wravler + реестр (src/registry.ts)
tools/
  wravler/   wrangler 4.141.0 с адресом и токеном нашей платформы
examples/    воркеры для проверки, деплоятся через wravler
  test/      тестовый воркер: страница с версией из [vars], /json, /echo, /error
  hello/
  counter/   с DO: пока отклоняется, цель следующего этапа
```

Образы (`engine/Dockerfile`, контекст сборки — корень репозитория):

| Образ | Что внутри |
|---|---|
| `engine` | только бинарник workerd, без кода и конфига |
| `workerd-platform` | engine + `config.capnp` + собранные `gateway/` и `api/` в `/app` |
| `workerd-egress` | engine + `egress.capnp`, без JS |
| `workerd-backup` | debian-slim + sqlite3 + `backup/backup.sh` |

Volumes: `workerd_data` (`/data`: реестр `platform-Registry/` и данные DO) и `workerd_backups` (архивы бэкапа).

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

## Панель

`https://panel.<ROOT_DOMAIN>` (у нас `panel.workers.ava-kk.ru`) показывает список задеплоенных воркеров: имя со ссылкой, активную версию, сколько версий хранится, когда создан и обновлён. Воркер можно удалить со всеми версиями, с подтверждением. Служебные `gateway` и `api` в реестре не хранятся, поэтому в списке их нет. Имя `panel` занято платформой.

Вход по токену платформы (тот же, что у wravler). Дальше сессия держится в cookie на 30 дней: `HttpOnly`, `Secure`, `SameSite=Strict`, поэтому чужой сайт не может отправить форму удаления от твоего имени. Страницы рендерятся в api-воркере (`workers/api/src/panel.ts`), без фреймворков и внешних скриптов.

## Живые логи

```bash
wravler tail test                  # console.*, исключения, статус каждого запроса
wravler tail test --format json    # полные события
```

Как это устроено: gateway загружает каждый воркер с `tails: [api]`, workerd отдаёт его события в `api.tail()`. Оттуда они уходят в `TailHub`, это DO по одному на воркер, который держит WebSocket-сессии wrangler. Пока никто не смотрит tail, события отбрасываются. Новая сессия начинает получать события не позже чем через 2 секунды.

Заголовки `authorization`, `cookie`, `set-cookie` и `proxy-authorization` в логах заменяются на `REDACTED`. На WebSocket wrangler токен не присылает, поэтому секретом служит id сессии: его выдаёт только `POST .../tails` по токену.

## Изоляция

- **Загруженный воркер видит только свой `env`** (сейчас это `[vars]`). До реестра, api, соседних воркеров и самого загрузчика он не дотягивается.
- **Биндинги работают в одну сторону.** Если A подключён к B, то B может только отвечать A, сам вызвать A он не может.
- **Сеть: только публичный интернет.** Приватные адреса (`10.x`, `172.16.x`, `192.168.x`, `127.x`: сам хост, соседние контейнеры, локальная сеть) workerd блокирует по умолчанию (`connect() blocked by restrictPeers()`). Проверено воркером-пробником.
- **На уровне Docker: internal-сеть + egress.** Контейнер workerd сидит только в `workerd_internal` (overlay, `--internal`). Шлюза там нет, поэтому у контейнера **нет маршрута** к хосту (ни к его сервисам, ни к опубликованным портам других контейнеров), LAN, соседним контейнерам и интернету. Всё это проверено TCP-подключением из сетевого пространства контейнера в обход workerd: везде `ENETUNREACH`. В этой сети есть только `caddy-server` (вход) и `egress` (выход).
- **egress** — тот же образ движка без JS (`config/egress.capnp`): сокет в режиме HTTP-прокси → `network` с `allow = ["public"]` и TLS. В основном конфиге сервис `internet` указывает на egress, и все воркеры, включая загруженные на лету, ходят наружу через него: `fetch`, WebSocket, `connect()`. Приватные адреса egress отклоняет. У egress есть своя обычная сеть с выходом наружу, но пользовательского кода в нём нет.
- **Доступ к внутреннему** (база, сервис в LAN) давать точечно: отдельный вход в egress на один адрес и порт плюс биндинг только нужному воркеру. Не расширять `allow` у egress: тогда адрес станет доступен всем воркерам.
- **Внутренний прокси для заблокированных сайтов** (если он есть в LAN) воркерам недоступен: у него приватный адрес. Если понадобится, это будет явное исключение в egress.
- Платформа и воркеры живут в одном процессе, поэтому для **чужого** недоверенного кода этого мало: по README workerd такой код нужно дополнительно запирать в VM. Для своего кода изоляции хватает.

Список воркеров:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/wravler/token)" https://api.workers.ava-kk.ru/client/v4/accounts/ava/workers/scripts
```

## Деплой платформы

```bash
DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml up -d --build
```

Код платформы (TypeScript) собирается и проверяется внутри Docker, скриптов и `docker cp` нет. Контейнер workerd пересоздаётся на несколько секунд, а задеплоенные через wravler воркеры лежат в реестре (`/data`) и никуда не пропадают.

Настройки лежат в `deploy/.env` (в git не попадает, образец — `deploy/.env.example`). compose читает его сам при **любой** команде. Если `WRAVLER_TOKEN` пустой, compose откажется запускаться, поэтому поднять платформу с закрытым API случайно нельзя.

## Бэкап

Сервис `backup` раз в `BACKUP_INTERVAL_HOURS` (по умолчанию 24) снимает копию `/data` в `workerd-data-<время>.tar.gz` и хранит последние `BACKUP_KEEP` (по умолчанию 7). Первая копия делается сразу при старте. Базы SQLite копируются через `.backup`, это согласованный снимок даже во время записи. Куда класть архивы, задаёт `BACKUP_TARGET`: named volume (по умолчанию `workerd_backups`) или абсолютный путь на сервере, доступный на запись uid 10001.

Восстановление:

```bash
C="docker compose -f deploy/compose.yaml"            # DOCKER_CONTEXT=manager
$C stop workerd
docker run --rm -v workerd_workerd_data:/data -v workerd_workerd_backups:/b:ro --entrypoint sh workerd-backup:local \
  -c 'rm -rf /data/* && tar -xzf /b/workerd-data-<время>.tar.gz -C /data'
$C start workerd
```

Пока архивы лежат на том же сервере, что и данные, они спасают от ошибок и порчи базы, но не от потери сервера.

## Docker

Рабочий контекст — `manager`. compose сам контекст не выбирает, поэтому указывай его явно: `DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml ...`.

Bind mount с относительным путём (`./x:/y`) не работает, потому что демон удалённый. Можно использовать только абсолютный путь на сервере или named volume. Docker Hub недоступен, поэтому базовые образы берутся через `mirror.gcr.io` (аргумент `REGISTRY` в `engine/Dockerfile`).

## Caddy

Контейнер подключён к внешней overlay-сети `workerd_internal` (`--internal --attachable`). Лейблы для caddy-docker-proxy отдают на него `ROOT_DOMAIN` и `*.ROOT_DOMAIN` из `deploy/.env` (у нас `workers.ava-kk.ru`). В DNS нужны обе записи. Gateway и api берут домен из той же переменной. Домен в wravler зашит отдельно.

В стеке Caddy для этого: `caddy-server` в сетях `caddy` и `workerd_internal`, у обоих сервисов `--ingress-networks=caddy,workerd_internal`. Управляющая сеть (`--controller-network`) остаётся `caddy`. Связь контейнеров внутри internal-сети работает, поэтому Caddy видит workerd.

Если сеть придётся пересоздать: `docker network create --driver overlay --internal --attachable workerd_internal`. Сначала в сеть должен войти Caddy, потом workerd, иначе `*.workers.ava-kk.ru` перестанет открываться.

Wildcard-сертификат Caddy получает через DNS-01. Эта проверка уже включена в Caddy глобально (`acme_dns cloudflare {env.CF_API_TOKEN}`).
**Свой `caddy.tls.*` в лейблы не добавлять:** если блок невалидный, Caddy отклоняет весь новый конфиг, и перестают применяться изменения для всех сайтов.

На хост порты не публикуются: Caddy (сервис Swarm, может работать на другом узле) ходит к контейнеру через overlay-сеть `workerd_internal`.
