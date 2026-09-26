#!/bin/sh
# Токен API платформы: создаёт его (один раз) и кладёт в два места:
#   ~/.config/wravler/token — его читает wravler;
#   deploy/.env             — его читает compose (из deploy/.env.example, если .env ещё нет).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$HOME/.config/wravler"
FILE="$DIR/token"
ENV="$ROOT/deploy/.env"

umask 077
if [ -f "$FILE" ]; then
  echo "токен уже есть: $FILE"
else
  mkdir -p "$DIR"
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$FILE"
  echo "создан $FILE"
fi
TOKEN="$(cat "$FILE")"

[ -f "$ENV" ] || cp "$ROOT/deploy/.env.example" "$ENV"
if grep -q '^WRAVLER_TOKEN=.\+' "$ENV"; then
  echo "в $ENV токен уже задан — не трогаю"
else
  sed -i "s/^WRAVLER_TOKEN=.*/WRAVLER_TOKEN=$TOKEN/" "$ENV"
  echo "токен записан в $ENV — задеплой платформу: DOCKER_CONTEXT=manager docker compose -f deploy/compose.yaml up -d --build"
fi
