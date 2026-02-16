#!/usr/bin/env bash
set -euo pipefail

# Zero-downtime deploy script for vers-agent-services
#
# Usage: ./scripts/deploy-zero-downtime.sh [branch]
#
# How it works:
# 1. Caddy runs on :3000 as reverse proxy (always up, holds connections)
# 2. App runs on :3001 (APP_PORT)
# 3. This script: pull code → build → graceful restart app → health check
#
# Caddy automatically retries failed upstream connections during the
# brief restart window, so clients see zero dropped requests.

REPO_DIR="${REPO_DIR:-/root/workspace/vers-agent-services}"
BRANCH="${1:-main}"
APP_PORT="${APP_PORT:-3001}"
HEALTH_URL="http://localhost:${APP_PORT}/health"
LOG_FILE="/tmp/agent-services.log"
MAX_HEALTH_RETRIES=30
HEALTH_RETRY_INTERVAL=1

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
fail() { echo -e "${RED}[deploy]${NC} $*"; exit 1; }

cd "$REPO_DIR"

# Step 1: Pull latest code
log "Pulling branch: $BRANCH"
git fetch origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# Step 2: Install dependencies
log "Installing dependencies..."
npm install --production=false 2>&1 | tail -5

# Step 3: Build
log "Building..."
if ! npm run build 2>&1; then
  fail "Build failed! Not restarting. Old version still running."
fi
log "Build succeeded."

# Step 4: Graceful restart
# Send SIGTERM to existing app process (if any)
OLD_PID=$(ss -tlnp | grep ":${APP_PORT}" | grep -oP 'pid=\K\d+' || true)
if [ -n "$OLD_PID" ]; then
  log "Stopping old process (PID: $OLD_PID)..."
  kill "$OLD_PID" 2>/dev/null || true
  # Wait for graceful shutdown (up to 10s)
  for i in $(seq 1 10); do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  # Force kill if still alive
  if kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Force killing old process..."
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# Step 5: Start new process
log "Starting new process on port ${APP_PORT}..."
nohup env \
  PORT="$APP_PORT" \
  VERS_AUTH_TOKEN="${VERS_AUTH_TOKEN:-}" \
  node dist/server.js > "$LOG_FILE" 2>&1 &
NEW_PID=$!
log "Started with PID: $NEW_PID"

# Step 6: Health check
log "Waiting for health check..."
for i in $(seq 1 $MAX_HEALTH_RETRIES); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    log "Health check passed!"
    break
  fi
  if [ "$i" -eq "$MAX_HEALTH_RETRIES" ]; then
    fail "Health check failed after ${MAX_HEALTH_RETRIES}s. Check $LOG_FILE"
  fi
  sleep "$HEALTH_RETRY_INTERVAL"
done

# Step 7: Verify endpoints
log "Verifying endpoints..."
UPTIME=$(curl -sf "$HEALTH_URL" | jq -r '.uptime // "unknown"')
log "App is live. Uptime: ${UPTIME}s"

# Step 8: Verify Caddy is proxying (port 3000 → 3001)
if curl -sf "http://localhost:3000/health" > /dev/null 2>&1; then
  log "Caddy proxy verified (port 3000 → ${APP_PORT})"
else
  warn "Caddy proxy check failed — is Caddy running on port 3000?"
fi

log "Deploy complete! Zero-downtime restart successful."
log "  App: http://localhost:${APP_PORT}"
log "  Proxy: http://localhost:3000"
