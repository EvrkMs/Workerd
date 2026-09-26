# Workerd

Своя платформа для воркеров на [workerd](https://github.com/cloudflare/workerd), открытом рантайме Cloudflare Workers, без сети Cloudflare.
Воркеры деплоятся командой `wravler deploy`, это wrangler, направленный на нашу платформу. После деплоя воркер сразу доступен на `https://<имя>.workers.ava-kk.ru`.

## Как устроено

```
wravler deploy ──> api.workers.ava-kk.ru (воркер api, формат Cloudflare API /client/v4)
                     └─> реестр (Durable Object на SQLite): воркеры, версии, код, vars

запрос <имя>.workers.ava-kk.ru ──> gateway ──> реестр: активная версия <имя>
                                     └─> Worker Loader: LOADER.get("<имя>@<версия>", код) → fetch
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

Список воркеров:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/wravler/token)" https://api.workers.ava-kk.ru/client/v4/accounts/ava/workers/scripts
```

## Деплой платформы

`sh deploy/deploy.sh` собирает `workers/*`, копирует их вместе с `config.capnp` в volume `/app`, workerd (`--watch`) перезапускается. Задеплоенные через wravler воркеры лежат в реестре (`/data`) и никуда не пропадают.

Токен api приходит из `~/.config/wravler/token` через переменную `WRAVLER_TOKEN`. Если токен пустой, api отвечает 401 на всё.

## Docker

Рабочий контекст — `manager`. `deploy.sh` выставляет его сам через `DOCKER_CONTEXT`, так что текущий контекст значения не имеет. Для ручных команд: `DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml ...`.

Bind mount с относительным путём (`./x:/y`) не работает, потому что демон удалённый. Можно использовать только абсолютный путь на сервере или named volume. Docker Hub недоступен, поэтому базовые образы берутся через `mirror.gcr.io` (аргумент `REGISTRY` в `engine/Dockerfile`).

## Caddy

Контейнер подключён к внешней сети `caddy`. Лейблы для caddy-docker-proxy отдают на него `workers.ava-kk.ru` и `*.workers.ava-kk.ru`.

Wildcard-сертификат Caddy получает через DNS-01. Эта проверка уже включена в Caddy глобально (`acme_dns cloudflare {env.CF_API_TOKEN}`).
**Свой `caddy.tls.*` в лейблы не добавлять:** если блок невалидный, Caddy отклоняет весь новый конфиг, и перестают применяться изменения для всех сайтов.

На хост порты не публикуются: Caddy (сервис Swarm, может крутиться на другом узле) ходит к контейнеру через overlay-сеть `caddy`.
