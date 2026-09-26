#!/bin/sh
# Volume /app при первом запуске пустой — ждём, пока деплой положит конфиг.
set -e

CONFIG=/app/config.capnp

until [ -f "$CONFIG" ]; do
  echo "waiting for $CONFIG ..."
  sleep 2
done

exec workerd serve "$CONFIG" --watch --verbose "$@"
