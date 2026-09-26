# Workerd

Своя платформа для воркеров на [workerd](https://github.com/cloudflare/workerd), открытом рантайме Cloudflare Workers, без сети Cloudflare.
Приложения лежат в своих репозиториях, здесь только движок, деплой и конфиг.

## Структура

```
engine/     образ движка: debian-slim + бинарник workerd, без кода
deploy/     compose.yaml и deploy.sh
config/     config.capnp — какие воркеры, сокеты, биндинги
workers/    воркеры, каждый со своим package.json (сейчас только hello)
```

В контейнере:

| Путь | Volume | Что лежит |
|---|---|---|
| `/app` | `workerd_app` | `config.capnp` и собранные воркеры (`<имя>/index.js`) |
| `/data` | `workerd_data` | SQLite-файлы Durable Objects |

Пока в `/app` нет конфига, движок ждёт. Когда конфиг появился, запускается с `--watch` и перезапускается сам при каждом новом деплое.

## Docker

Рабочий контекст — `manager`. Bind mount с относительным путём (`./x:/y`) там не работает, потому что демон удалённый. Можно использовать только абсолютный путь на сервере или named volume.

## Caddy

Контейнер подключён к внешней сети `caddy` (имя меняется через `CADDY_NETWORK`). Лейблы для caddy-docker-proxy отдают на него `workers.ava-kk.ru` и `*.workers.ava-kk.ru`.

Что нужно для wildcard:
- DNS-запись `*.workers.ava-kk.ru` в Cloudflare;
- Caddy, собранный с модулем `caddy-dns/cloudflare`;
- `CLOUDFLARE_API_TOKEN` в окружении Caddy, с правом Zone.DNS:Edit на `ava-kk.ru`.

Для локального запуска сеть создаётся один раз: `docker network create caddy`.

## Команды

Все команды выполняются в WSL-дистрибутиве `claude`:

```bash
cd workers/hello && npm install    # один раз для каждого воркера
sh deploy/deploy.sh                # сборка, образ, доставка в volume
curl http://<хост>:8080/
```
