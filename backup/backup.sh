#!/bin/sh
# Раз в BACKUP_INTERVAL_HOURS снимает копию /data в /backups/workerd-data-<время>.tar.gz
# и оставляет последние BACKUP_KEEP архивов. Первая копия — сразу при старте.
#
# Базы SQLite копируются через `.backup`: это согласованный снимок даже во время записи
# (простое копирование файла с WAL может дать битую базу). Остальные файлы — как есть.
set -eu

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP="${BACKUP_KEEP:-7}"

snapshot() {
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  tmp="$(mktemp -d)"

  cd /data
  find . -type f -name '*.sqlite' | while read -r db; do
    mkdir -p "$tmp/$(dirname "$db")"
    sqlite3 "$db" ".backup '$tmp/$db'"
  done
  # служебные файлы SQLite не нужны: снимок уже полный
  find . -type f ! -name '*.sqlite' ! -name '*.sqlite-wal' ! -name '*.sqlite-shm' | while read -r f; do
    mkdir -p "$tmp/$(dirname "$f")"
    cp -p "$f" "$tmp/$f"
  done

  archive="/backups/workerd-data-$stamp.tar.gz"
  tar -czf "$archive.part" -C "$tmp" .
  mv "$archive.part" "$archive"
  rm -rf "$tmp"

  # ротация: оставить KEEP самых свежих
  ls -1t /backups/workerd-data-*.tar.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f

  echo "$(date -u +%FT%TZ) backup ok: $archive ($(du -h "$archive" | cut -f1)), всего $(ls -1 /backups/workerd-data-*.tar.gz | wc -l)"
}

while true; do
  snapshot || echo "$(date -u +%FT%TZ) backup FAILED" >&2
  sleep "$((INTERVAL_HOURS * 3600))"
done
