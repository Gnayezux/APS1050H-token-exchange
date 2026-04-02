#!/usr/bin/env bash
set -e

GANACHE_HOST="127.0.0.1"
GANACHE_PORT="8545"
GANACHE_URL="http://$GANACHE_HOST:$GANACHE_PORT"

# ── Check if Ganache is already running ─────────────────────────────────────
if curl -s -X POST "$GANACHE_URL" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' \
    > /dev/null 2>&1; then
  echo "[✓] Ganache already running at $GANACHE_URL"
else
  echo "[*] Starting Ganache..."
  ganache --host $GANACHE_HOST --port $GANACHE_PORT > /tmp/ganache.log 2>&1 &
  GANACHE_PID=$!
  echo "    PID: $GANACHE_PID"

  # Wait for Ganache to be ready
  for i in $(seq 1 10); do
    if curl -s -X POST "$GANACHE_URL" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' \
        > /dev/null 2>&1; then
      echo "[✓] Ganache ready"
      break
    fi
    if [ "$i" -eq 10 ]; then
      echo "[✗] Ganache failed to start. Check /tmp/ganache.log"
      exit 1
    fi
    sleep 1
  done
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
echo ""
echo "[*] Running Truffle migration..."
truffle migrate --network development --reset

echo ""
echo "[✓] Deployment complete."
