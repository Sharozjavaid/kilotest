#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster for local runs and tests, and prints its DATABASE_URL.
# Idempotent: if the cluster is already running it only prints the URL.
#   KILO_DEV_DB_PORT  port to listen on (default 54329)
#   KILO_DEV_DB_DIR   cluster directory (default $TMPDIR/kilo-server-pg-<port>)
#   scripts/dev-db.sh stop   stops the cluster
set -euo pipefail

PORT="${KILO_DEV_DB_PORT:-54329}"
DIR="${KILO_DEV_DB_DIR:-${TMPDIR:-/tmp}/kilo-server-pg-${PORT}}"
BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [[ -z "${BIN}" || ! -x "${BIN}/pg_ctl" ]]; then
  BIN="$(dirname "$(command -v pg_ctl)")"
fi

# PostgreSQL refuses to run as root; run its binaries as the postgres OS user then.
as_pg() {
  if [[ "$(id -u)" == "0" ]]; then runuser -u postgres -- "$@"; else "$@"; fi
}

url="postgres://postgres@127.0.0.1:${PORT}/postgres"

if [[ "${1:-}" == "stop" ]]; then
  as_pg "${BIN}/pg_ctl" -D "${DIR}/data" -m fast stop >/dev/null 2>&1 || true
  exit 0
fi

if [[ -f "${DIR}/data/PG_VERSION" ]] && as_pg "${BIN}/pg_ctl" -D "${DIR}/data" status >/dev/null 2>&1; then
  echo "DATABASE_URL=${url}"
  exit 0
fi

mkdir -p "${DIR}"
if [[ "$(id -u)" == "0" ]]; then chown postgres "${DIR}"; fi
if [[ ! -f "${DIR}/data/PG_VERSION" ]]; then
  as_pg "${BIN}/initdb" -D "${DIR}/data" -U postgres --auth=trust -E UTF8 --no-locale >"${DIR}/initdb.log" 2>&1
fi
as_pg "${BIN}/pg_ctl" -D "${DIR}/data" -l "${DIR}/server.log" -w -t 30 \
  -o "-p ${PORT} -k ${DIR} -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
  start >/dev/null
echo "DATABASE_URL=${url}"
