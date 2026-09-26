# Workerd

Своя платформа для воркеров на [workerd](https://github.com/cloudflare/workerd), открытом рантайме Cloudflare Workers, без сети Cloudflare.
Приложения лежат в своих репозиториях, здесь только движок, деплой и конфиг.

## Структура

```
engine/     образ движка: debian-slim + бинарник workerd, без кода
deploy/     compose.yaml и deploy.sh
config/     config.capnp — какие воркеры, сокеты, биндинги
workers/    воркеры, каждый со своим package.json
  gateway/  точка входа: <имя>.workers.ava-kk.ru → service binding <имя>
  hello/    пример воркера
  counter/  тестовый Durable Object (SQLite): счётчик обращений по пути
```

## Маршрутизация

Все запросы приходят в `gateway`, он выбирает воркер по поддомену. Чтобы добавить воркер:
1. создать папку `workers/<имя>/`;
2. в `config.capnp` описать сервис `<имя>` и добавить биндинг `(name = "<имя>", service = "<имя>")` в `gatewayWorker`.

Имена воркеров пишутся в нижнем регистре (`[a-z0-9-]`), переменные окружения — в UPPER_CASE, поэтому они не пересекаются.

## Durable Objects

Хранилище — сервис `do-storage` (`/data`, volume `workerd_data`). Для каждого namespace workerd создаёт папку `/data/<uniqueKey>/`, в ней `<id>.sqlite` на каждый объект и `metadata.sqlite`. Проверено: данные переживают и перезапуск, и пересоздание контейнера.

Для DO нужны `enableSql = true` и `durableObjectStorage = (localDisk = "do-storage")`. `uniqueKey` после запуска не меняется: он определяет, где лежат данные.

В контейнере:

| Путь | Volume | Что лежит |
|---|---|---|
| `/app` | `workerd_app` | `config.capnp` и собранные воркеры (`<имя>/index.js`) |
| `/data` | `workerd_data` | SQLite-файлы Durable Objects |

Пока в `/app` нет конфига, движок ждёт. Когда конфиг появился, запускается с `--watch` и перезапускается сам при каждом новом деплое.

## Docker

Рабочий контекст — `manager`. `deploy.sh` выставляет его сам через `DOCKER_CONTEXT`, так что текущий контекст значения не имеет. Для ручных команд: `DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml ...`.

Bind mount с относительным путём (`./x:/y`) там не работает, потому что демон удалённый. Можно использовать только абсолютный путь на сервере или named volume.

## Caddy

Контейнер подключён к внешней сети `caddy`. Лейблы для caddy-docker-proxy отдают на него `workers.ava-kk.ru` и `*.workers.ava-kk.ru`.

Wildcard-сертификат Caddy получает через DNS-01. Эта проверка уже включена в Caddy глобально (`acme_dns cloudflare {env.CF_API_TOKEN}`), DNS-запись `*.workers` есть в Cloudflare.
**Свой `caddy.tls.*` в лейблы не добавлять:** если блок невалидный, Caddy отклоняет весь новый конфиг, и перестают применяться изменения для всех сайтов.

На хост порты не публикуются: Caddy (сервис Swarm, может крутиться на другом узле) ходит к контейнеру через overlay-сеть `caddy`.

Для локального запуска сеть создаётся один раз: `docker network create caddy`.

## Команды

Все команды выполняются в WSL-дистрибутиве `claude`:

```bash
sh deploy/deploy.sh                       # npm ci (если нужно), проверка типов, сборка, доставка в volume
curl https://counter.workers.ava-kk.ru/a  # {"path":"/a","count":N}
```
