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
| `wravler tail` (логи, исключения, запросы) | ✅ фильтры (`--status`, `--method`…) пока игнорируются |
| Durable Objects, service bindings, KV, D1, R2, секреты | ❌ деплой отклоняется с понятной ошибкой |

## Структура

```
engine/      образ движка: debian-slim + бинарник workerd, без кода
deploy/      compose.yaml и deploy.sh (деплой самой платформы)
config/      config.capnp: статичный конфиг платформы
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

В контейнере:

| Путь | Volume | Что лежит |
|---|---|---|
| `/app` | `workerd_app` | `config.capnp` и код платформы (`gateway/`, `api/`) |
| `/data` | `workerd_data` | реестр (`platform-Registry/`) и данные DO |

## Установка (один раз, в WSL-дистрибутиве `claude`)

```bash
sh tools/wravler/init-token.sh                                 # токен в ~/.config/wravler/token
(cd tools/wravler && npm install) && npm install -g ./tools/wravler
sh deploy/deploy.sh                                            # платформа узнаёт токен
```

## Деплой воркера

```bash
cd examples/hello
wravler deploy            # → https://hello.workers.ava-kk.ru
wravler delete --name hello
```

wrangler в конце печатает адрес вида `hello.ava.workers.dev`: этот формат зашит в нём. Настоящий адрес `wravler` печатает строкой ниже.

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
- **Сеть: только публичный интернет.** Приватные адреса (`10.x`, `127.x` и т.д.: сам хост, соседние контейнеры, локальная сеть) workerd блокирует по умолчанию (`connect() blocked by restrictPeers()`). Проверено воркером-пробником.
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

`sh deploy/deploy.sh` собирает `workers/*`, копирует их вместе с `config.capnp` в volume `/app`, workerd (`--watch`) перезапускается. Задеплоенные через wravler воркеры лежат в реестре (`/data`) и никуда не пропадают.

Токен api приходит из `~/.config/wravler/token` через переменную `WRAVLER_TOKEN`. Если токен пустой, api отвечает 401 на всё.
**Поднимать контейнер только через `deploy.sh`:** обычный `docker compose up` пересоздаст его без токена, и wravler начнёт получать 401.

## Docker

Рабочий контекст — `manager`. `deploy.sh` выставляет его сам через `DOCKER_CONTEXT`, так что текущий контекст значения не имеет. Для ручных команд: `DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml ...`.

Bind mount с относительным путём (`./x:/y`) не работает, потому что демон удалённый. Можно использовать только абсолютный путь на сервере или named volume. Docker Hub недоступен, поэтому базовые образы берутся через `mirror.gcr.io` (аргумент `REGISTRY` в `engine/Dockerfile`).

## Caddy

Контейнер подключён к внешней overlay-сети `workerd_internal` (`--internal --attachable`). Лейблы для caddy-docker-proxy отдают на него `workers.ava-kk.ru` и `*.workers.ava-kk.ru`.

В стеке Caddy для этого: `caddy-server` в сетях `caddy` и `workerd_internal`, у обоих сервисов `--ingress-networks=caddy,workerd_internal`. Управляющая сеть (`--controller-network`) остаётся `caddy`. Связь контейнеров внутри internal-сети работает, поэтому Caddy видит workerd.

Если сеть придётся пересоздать: `docker network create --driver overlay --internal --attachable workerd_internal`. Сначала в сеть должен войти Caddy, потом workerd, иначе `*.workers.ava-kk.ru` перестанет открываться.

Wildcard-сертификат Caddy получает через DNS-01. Эта проверка уже включена в Caddy глобально (`acme_dns cloudflare {env.CF_API_TOKEN}`).
**Свой `caddy.tls.*` в лейблы не добавлять:** если блок невалидный, Caddy отклоняет весь новый конфиг, и перестают применяться изменения для всех сайтов.

На хост порты не публикуются: Caddy (сервис Swarm, может работать на другом узле) ходит к контейнеру через overlay-сеть `workerd_internal`.
