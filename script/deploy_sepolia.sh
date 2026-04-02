#!/usr/bin/env bash
set -e

ENV_FILE="$(dirname "$0")/../.env"

# ── Check .env exists ────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "[✗] .env file not found. Copy .env.example and fill in your values:"
  echo "    cp .env.example .env"
  exit 1
fi

# ── Load and validate required vars ─────────────────────────────────────────
source "$ENV_FILE"

if [ -z "$PRIVATE_KEY" ]; then
  echo "[✗] PRIVATE_KEY is not set in .env"
  exit 1
fi

if [ -z "$SEPOLIA_RPC_URL" ]; then
  echo "[✗] SEPOLIA_RPC_URL is not set in .env"
  exit 1
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
echo "[*] Deploying to Sepolia..."
echo "    RPC: $SEPOLIA_RPC_URL"
echo ""

truffle migrate --network sepolia --reset

echo ""
echo "[✓] Deployment complete."
