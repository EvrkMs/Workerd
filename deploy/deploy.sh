#!/bin/sh
# Собирает воркеры, раскладывает их вместе с config.capnp в .build/app
# и копирует в volume контейнера. workerd (--watch) перезапустится сам.
#
# Внутри /app:
#   config.capnp
#   <имя воркера>/index.js
#
# Docker-контекст берётся текущий (manager); для локального запуска задай DOCKER_HOST.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/app"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT/config/config.capnp" "$OUT/"

for dir in "$ROOT"/workers/*/; do
  name="$(basename "$dir")"
  echo "== $name"
  (cd "$dir" && npm run typecheck && npm run build)
  mkdir -p "$OUT/$name"
  cp "$dir"/dist/* "$OUT/$name/"
done

docker compose -f "$ROOT/deploy/compose.yaml" up -d --build
docker compose -f "$ROOT/deploy/compose.yaml" cp "$OUT/." workerd:/app/

echo "deployed"
