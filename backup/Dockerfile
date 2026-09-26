# Бэкап /data (реестр воркеров и данные Durable Objects): sqlite3 + скрипт с ротацией.
ARG REGISTRY=mirror.gcr.io/library
FROM ${REGISTRY}/debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /backups \
 && chown 10001:10001 /backups

COPY --chmod=755 backup.sh /usr/local/bin/backup.sh

# Тот же uid, что у workerd: служебные файлы SQLite (-wal/-shm), если их создаст бэкап,
# останутся доступны workerd.
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/backup.sh"]
