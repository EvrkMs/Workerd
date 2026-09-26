# Образы платформы. Контекст сборки — корень репозитория (см. .dockerignore).
#
#   engine   — чистый движок: только бинарник workerd, без кода и конфига
#   platform — engine + config/config.capnp + собранные workers/gateway, workers/api и panel
#   egress   — engine + config/egress.capnp (без JS: выход в интернет, только публичные адреса)
#
# Пользовательские воркеры в образы не входят: они деплоятся через wravler в реестр (/data).

ARG WORKERD_VERSION=1.20260926.1
# Docker Hub недоступен напрямую — базовые образы берём через зеркало
ARG REGISTRY=mirror.gcr.io/library

FROM ${REGISTRY}/node:24-slim AS fetch
ARG WORKERD_VERSION
WORKDIR /tmp/w
RUN npm install --no-save --no-audit --no-fund "workerd@${WORKERD_VERSION}" \
 && cp node_modules/@cloudflare/workerd-linux-64/bin/workerd /workerd

# workerd нужна glibc >= 2.35, поэтому не alpine
FROM ${REGISTRY}/debian:trixie-slim AS engine
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin workerd \
 && mkdir -p /app /data \
 && chown workerd:workerd /app /data

COPY --from=fetch /workerd /usr/local/bin/workerd

USER workerd
WORKDIR /app
EXPOSE 8080
# Конфиг лежит в образе (platform/egress). Дополнительные флаги — через command
# в compose (например --experimental для Worker Loader).
ENTRYPOINT ["workerd", "serve", "/app/config.capnp", "--verbose"]

# --- сборка воркеров платформы (typecheck + esbuild) ---------------------------
FROM ${REGISTRY}/node:24-slim AS build
WORKDIR /src/workers
# сначала только зависимости — слой кэшируется, пока не менялись package*.json
COPY workers/api/package.json workers/api/package-lock.json api/
COPY workers/gateway/package.json workers/gateway/package-lock.json gateway/
RUN (cd api && npm ci --no-audit --no-fund) && (cd gateway && npm ci --no-audit --no-fund)
COPY workers/ ./
RUN for w in api gateway; do (cd "$w" && npm run typecheck && npm run build) || exit 1; done

# --- веб-панель (React + Vite) ---------------------------------------------------------
FROM ${REGISTRY}/node:24-slim AS panel
WORKDIR /src/panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY panel/ ./
RUN npm run build

FROM engine AS platform
COPY config/config.capnp /app/config.capnp
COPY --from=build /src/workers/gateway/dist/ /app/gateway/
COPY --from=build /src/workers/api/dist/ /app/api/
# раздаёт api-воркер на panel.<ROOT_DOMAIN> (disk-сервис panel-ui в config.capnp)
COPY --from=panel /src/panel/dist/ /app/panel/

FROM engine AS egress
COPY config/egress.capnp /app/config.capnp
