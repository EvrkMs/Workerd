# Чистый образ движка: только бинарник workerd, без кода воркеров.
# Код и config.capnp приходят через volume /app, данные DO лежат в volume /data.

ARG WORKERD_VERSION=1.20260926.1
# Docker Hub недоступен напрямую — базовые образы берём через зеркало
ARG REGISTRY=mirror.gcr.io/library

FROM ${REGISTRY}/node:24-slim AS fetch
ARG WORKERD_VERSION
WORKDIR /tmp/w
RUN npm install --no-save --no-audit --no-fund "workerd@${WORKERD_VERSION}" \
 && cp node_modules/@cloudflare/workerd-linux-64/bin/workerd /workerd

# workerd нужна glibc >= 2.35, поэтому не alpine
FROM ${REGISTRY}/debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin workerd \
 && mkdir -p /app /data \
 && chown workerd:workerd /app /data

COPY --from=fetch /workerd /usr/local/bin/workerd
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER workerd
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
