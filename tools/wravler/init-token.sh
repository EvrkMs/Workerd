#!/bin/sh
# Создаёт токен API платформы (один раз). Его читают wravler и deploy/deploy.sh.
set -e
DIR="$HOME/.config/wravler"
FILE="$DIR/token"
if [ -f "$FILE" ]; then
  echo "токен уже есть: $FILE"
  exit 0
fi
mkdir -p "$DIR"
umask 077
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$FILE"
echo "создан $FILE — теперь задеплой платформу (sh deploy/deploy.sh), чтобы она узнала токен"
