#!/bin/sh
# DeltaDesk server entrypoint (Railway): tape recorder + refresh loop + API, sharing /app/data (a mounted volume).
set -e
mkdir -p /app/data
node recorder/tape.mjs >> /app/data/recorder.log 2>&1 &
(
  cd engine
  while true; do
    uv run --no-sync python -m pipeline.refresh >> /app/data/refresh.log 2>&1 || true
    sleep "${REFRESH_EVERY_S:-600}"
  done
) &
cd engine
exec uv run --no-sync uvicorn api.app:app --host :: --port "${PORT:-8787}" --proxy-headers
