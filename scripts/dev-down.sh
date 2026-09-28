#!/usr/bin/env bash
# Stops what dev-up.sh started. Leaves the database alone — stopping the app
# must never be a way to lose data.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
for svc in api web; do
  if [[ -f ".run/$svc.pid" ]]; then
    kill "$(cat ".run/$svc.pid")" 2>/dev/null && echo "Stopped $svc."
    rm -f ".run/$svc.pid"
  fi
done
# `pnpm ... start` wraps `next start`, which in turn spawns `next-server`.
# Killing only the wrapper leaves the actual listener holding :3000, so match
# the server process too.
pkill -f "apps/api/dist/main.js" 2>/dev/null
pkill -f "next start" 2>/dev/null
pkill -f "next-server" 2>/dev/null

for port in 3000 3001; do
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null --max-time 1 "http://localhost:$port" 2>/dev/null || break
    sleep 1
  done
  if curl -s -o /dev/null --max-time 1 "http://localhost:$port" 2>/dev/null; then
    echo "WARNING: something is still listening on :$port" >&2
  fi
done
echo "Postgres and Redis left running (docker compose down stops them)."
