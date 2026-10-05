#!/usr/bin/env bash
# End-to-end smoke test on a throwaway stack that touches nothing of yours: a fresh backend and
# database, a LiveKit container on other ports (7890-7892), and a small proxy in front of both (18090),
# like the reverse proxy in DEPLOY.md. Needs Go, Node, Docker with the livekit/livekit-server image, and
# Chromium (set CHROMIUM if it isn't on your PATH). `./run.sh a11y` runs the accessibility audit instead.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
WORK=$(mktemp -d)
CHROMIUM=${CHROMIUM:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}
[ -n "$CHROMIUM" ] || { echo "No Chromium found: set CHROMIUM=/path/to/chromium" >&2; exit 1; }
export CHROMIUM
LIVEKIT_IMAGE=${LIVEKIT_IMAGE:-livekit/livekit-server:v1.13.7}
NAME=gumcord-e2e-livekit
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# A leftover stack on these ports would be tested instead of this one.
for port in 7890 7891 18080 18090; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Port $port is already in use: is another e2e run still going?" >&2
    exit 1
  fi
done

[ -d node_modules ] || npm install --no-audit --no-fund
(cd "$ROOT" && npm run build >/dev/null)
(cd "$ROOT/backend" && go build -o "$WORK/gumcord" .)

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" --network host -v "$PWD/livekit.yaml:/etc/livekit.yaml:ro" "$LIVEKIT_IMAGE" --config /etc/livekit.yaml >/dev/null

mkdir "$WORK/data"
LK_API_KEY=e2ekey LK_API_SECRET=e2e-secret-e2e-secret-e2e-secret-1234 LIVEKIT_API_URL=http://127.0.0.1:7890 \
  DEV_LOGIN=1 DATA_DIR="$WORK/data" ADDR=127.0.0.1:18080 STATIC_DIR="$ROOT/build" BACKUP_INTERVAL=off \
  "$WORK/gumcord" >"$WORK/backend.log" 2>&1 &
PIDS+=($!)
node proxy.mjs >"$WORK/proxy.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 50); do
  curl -s -o /dev/null http://127.0.0.1:18090/api/me && break
  sleep 0.2
done

# Which check: smoke (default) or a11y.
if ! node "${1:-smoke}.mjs"; then
  echo "--- backend log" >&2; tail -20 "$WORK/backend.log" >&2
  exit 1
fi
