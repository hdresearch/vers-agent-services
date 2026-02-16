#!/usr/bin/env bash
set -euo pipefail

# Test zero-downtime deploys by hammering the health endpoint
# while restarting the app process.
#
# Usage: ./scripts/test-zero-downtime.sh
#
# Prerequisites:
# - Caddy running on :3000 (via setup-zero-downtime.sh or manually)
# - App running on :3001
#
# What it does:
# 1. Starts continuous requests to :3000 (through Caddy)
# 2. Restarts the app on :3001
# 3. Counts successes, failures, and the total gap time
# 4. Reports results

APP_PORT="${APP_PORT:-3001}"
PROXY_PORT="${PROXY_PORT:-3000}"
PROXY_URL="http://localhost:${PROXY_PORT}/health"
APP_URL="http://localhost:${APP_PORT}/health"
DURATION=15  # seconds to run the test
RESULTS_FILE="/tmp/zero-downtime-results.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[test]${NC} $*"; }
warn() { echo -e "${YELLOW}[test]${NC} $*"; }
fail() { echo -e "${RED}[test]${NC} $*"; }

# Pre-flight checks
log "Pre-flight checks..."
if ! curl -sf "$PROXY_URL" > /dev/null 2>&1; then
  fail "Caddy proxy not responding on :${PROXY_PORT}. Run setup-zero-downtime.sh first."
  exit 1
fi
if ! curl -sf "$APP_URL" > /dev/null 2>&1; then
  fail "App not responding on :${APP_PORT}."
  exit 1
fi
log "Both proxy (:${PROXY_PORT}) and app (:${APP_PORT}) are healthy."

# Start continuous request bombardment
log "Starting continuous requests for ${DURATION}s..."
> "$RESULTS_FILE"

# Background job: send requests every 50ms through Caddy
(
  END=$((SECONDS + DURATION))
  while [ $SECONDS -lt $END ]; do
    START_MS=$(date +%s%3N)
    STATUS=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$PROXY_URL" 2>/dev/null || echo "000")
    END_MS=$(date +%s%3N)
    LATENCY=$((END_MS - START_MS))
    echo "${STATUS} ${LATENCY}" >> "$RESULTS_FILE"
    sleep 0.05
  done
) &
BOMBARDMENT_PID=$!

# Wait 3 seconds for baseline, then restart the app
sleep 3
log "Restarting app process (simulating deploy)..."

# Kill old process
OLD_PID=$(ss -tlnp | grep ":${APP_PORT}" | grep -oP 'pid=\K\d+' | head -1 || true)
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  log "Sent SIGTERM to PID $OLD_PID"
fi

# Brief gap (simulates build time in a real deploy)
sleep 2

# Start new process
log "Starting new app process..."
cd /root/workspace/vers-agent-services
nohup env PORT="$APP_PORT" VERS_AUTH_TOKEN="${VERS_AUTH_TOKEN:-}" node dist/server.js > /tmp/agent-services-test.log 2>&1 &
NEW_PID=$!
log "New process started: PID $NEW_PID"

# Wait for remaining bombardment
wait $BOMBARDMENT_PID 2>/dev/null || true

# Analyze results
log ""
log "═══════════════════════════════════════"
log "  ZERO-DOWNTIME TEST RESULTS"
log "═══════════════════════════════════════"

TOTAL=$(wc -l < "$RESULTS_FILE")
SUCCESS=$(grep -c '^200' "$RESULTS_FILE" || true)
FAILURES=$(grep -cv '^200' "$RESULTS_FILE" || true)
SUCCESS_RATE=$((SUCCESS * 100 / TOTAL))

# Calculate max latency
MAX_LATENCY=$(awk '{print $2}' "$RESULTS_FILE" | sort -n | tail -1)
AVG_LATENCY=$(awk '{sum+=$2; n++} END {printf "%.0f", sum/n}' "$RESULTS_FILE")

# Count consecutive failures (the "gap")
MAX_CONSECUTIVE_FAILURES=0
CURRENT_STREAK=0
while read -r line; do
  STATUS=$(echo "$line" | awk '{print $1}')
  if [ "$STATUS" != "200" ]; then
    CURRENT_STREAK=$((CURRENT_STREAK + 1))
    if [ $CURRENT_STREAK -gt $MAX_CONSECUTIVE_FAILURES ]; then
      MAX_CONSECUTIVE_FAILURES=$CURRENT_STREAK
    fi
  else
    CURRENT_STREAK=0
  fi
done < "$RESULTS_FILE"

log "  Total requests:     $TOTAL"
log "  Successful (200):   $SUCCESS"
log "  Failed:             $FAILURES"
log "  Success rate:       ${SUCCESS_RATE}%"
log "  Avg latency:        ${AVG_LATENCY}ms"
log "  Max latency:        ${MAX_LATENCY}ms"
log "  Max consecutive failures: $MAX_CONSECUTIVE_FAILURES"
log "═══════════════════════════════════════"

if [ "$FAILURES" -eq 0 ]; then
  log "✅ PERFECT: Zero dropped requests during restart!"
  EXIT_CODE=0
elif [ "$FAILURES" -le 3 ]; then
  warn "⚠️  NEAR-ZERO: Only $FAILURES dropped requests (acceptable)"
  EXIT_CODE=0
else
  fail "❌ FAILED: $FAILURES dropped requests out of $TOTAL"
  fail "   This indicates the restart gap is too long for Caddy to cover."
  EXIT_CODE=1
fi

# Cleanup: kill the test process
kill $NEW_PID 2>/dev/null || true

exit ${EXIT_CODE:-0}
