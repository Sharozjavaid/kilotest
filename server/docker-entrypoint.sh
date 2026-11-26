#!/bin/sh
# Container entry: `api`, `worker`, `dev` or `migrate` (see Dockerfile).
set -e
cd /app/server
case "${1:-api}" in
  api|worker|dev) exec node_modules/.bin/tsx src/main.ts "$1" ;;
  migrate) exec node_modules/.bin/tsx src/db/migrate-cli.ts ;;
  *) exec "$@" ;;
esac
