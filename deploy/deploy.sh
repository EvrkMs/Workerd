#!/bin/sh
# Деплой самой платформы (gateway + api). Пользовательские воркеры сюда не входят —
# они деплоятся через wravler и хранятся в реестре.
#
# Собирает воркеры платформы, раскладывает их вместе с config.capnp в .build/app
# и копирует в volume контейнера. workerd (--watch) перезапустится сам.
#
# Внутри /app:
#   config.capnp
#   <воркер платформы>/index.js
#
# По умолчанию деплоит на manager независимо от текущего docker context.
# Локально: DOCKER_CONTEXT=default sh deploy/deploy.sh
set -e
export DOCKER_CONTEXT="${DOCKER_CONTEXT:-manager}"
echo "docker context: $DOCKER_CONTEXT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.build/app"

TOKEN_FILE="$HOME/.config/wravler/token"
if [ -z "$WRAVLER_TOKEN" ]; then
  [ -f "$TOKEN_FILE" ] || { echo "нет $TOKEN_FILE — создай: sh tools/wravler/init-token.sh" >&2; exit 1; }
  WRAVLER_TOKEN="$(cat "$TOKEN_FILE")"
fi
export WRAVLER_TOKEN

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT/config/config.capnp" "$OUT/"

for dir in "$ROOT"/workers/*/; do
  name="$(basename "$dir")"
  echo "== $name"
  (cd "$dir" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run typecheck && npm run build)
  mkdir -p "$OUT/$name"
  cp "$dir"/dist/* "$OUT/$name/"
done

docker compose -f "$ROOT/deploy/compose.yaml" up -d --build
docker compose -f "$ROOT/deploy/compose.yaml" cp "$OUT/." workerd:/app/

echo "deployed"
