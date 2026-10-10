#!/usr/bin/env bash
# Sobe o provedor simulado (com chaos) e a API, roda o k6 em Docker e verifica as invariantes.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-3102}"
PROVIDER_PORT="${PROVIDER_PORT:-3112}"
WORK="$(mktemp -d)"
DB_PATH="$WORK/load.sqlite"
export NODE_OPTIONS='--disable-warning=ExperimentalWarning'

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${PROVIDER_PID:-}" ]] && kill "$PROVIDER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Relógio do provedor congelado: cada post tem exatamente uma medição durante a carga.
PROVIDER_PORT="$PROVIDER_PORT" PROVIDER_FIXED_NOW="2026-10-01T12:30:00Z" PROVIDER_CHAOS=1 \
CHAOS_5XX=0.1 CHAOS_429=0.05 CHAOS_RETRY_AFTER=1 CHAOS_LONG_429=0.002 CHAOS_LONG_RETRY_AFTER=3 \
CHAOS_TIMEOUT=0.02 CHAOS_TIMEOUT_HANG_MS=3000 CHAOS_DUPLICATE=0.2 \
  npx tsx src/fake-provider/server.ts > "$WORK/provider.log" 2>&1 &
PROVIDER_PID=$!

PORT="$API_PORT" DB_PATH="$DB_PATH" PROVIDER_BASE_URL="http://localhost:$PROVIDER_PORT" \
PROVIDER_TIMEOUT_MS=1000 SYNC_MAX_ATTEMPTS=6 SYNC_BACKOFF_BASE_MS=50 SYNC_BACKOFF_MAX_MS=800 \
SYNC_MAX_RETRY_AFTER_MS=2000 \
  npx tsx src/index.ts > "$WORK/api.log" 2>&1 &
API_PID=$!

for _ in $(seq 1 50); do
  if curl -fs "http://localhost:$API_PORT/health" > /dev/null && curl -s -o /dev/null "http://localhost:$PROVIDER_PORT/__admin/stats"; then
    break
  fi
  sleep 0.2
done

K6_STATUS=0
docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e BASE_URL="http://host.docker.internal:$API_PORT" \
  grafana/k6:0.54.0 run - < load/sync-storm.js || K6_STATUS=$?

VERIFY_STATUS=0
API_URL="http://localhost:$API_PORT" PROVIDER_URL="http://localhost:$PROVIDER_PORT" DB_PATH="$DB_PATH" \
  npx tsx scripts/verify-load.ts || VERIFY_STATUS=$?

if [[ $K6_STATUS -ne 0 || $VERIFY_STATUS -ne 0 ]]; then
  echo "carga falhou (k6=$K6_STATUS, verificação=$VERIFY_STATUS)"
  echo "--- api.log (fim)"; tail -n 30 "$WORK/api.log"
  exit 1
fi
