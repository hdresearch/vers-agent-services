#!/usr/bin/env bash
set -euo pipefail

# One-time setup for zero-downtime deploys
#
# Installs Caddy, configures systemd services, and starts everything.
# Run this once on the infra VM, then use deploy-zero-downtime.sh for updates.
#
# Usage: ./scripts/setup-zero-downtime.sh

REPO_DIR="${REPO_DIR:-/root/workspace/vers-agent-services}"
APP_PORT="${APP_PORT:-3001}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
fail() { echo -e "${RED}[setup]${NC} $*"; exit 1; }

# Step 1: Install Caddy
if ! command -v caddy &>/dev/null; then
  log "Installing Caddy..."
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
  log "Caddy installed: $(caddy version)"
else
  log "Caddy already installed: $(caddy version)"
fi

# Step 2: Create log directory
mkdir -p /var/log/caddy

# Step 3: Stop default Caddy service (we'll use our own config)
systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true

# Step 4: Create systemd service for Caddy with our Caddyfile
log "Creating Caddy systemd service..."
cat > /etc/systemd/system/agent-services-caddy.service << EOF
[Unit]
Description=Caddy reverse proxy for agent-services
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/caddy run --config ${REPO_DIR}/Caddyfile --adapter caddyfile
ExecReload=/usr/bin/caddy reload --config ${REPO_DIR}/Caddyfile --adapter caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# Step 5: Create systemd service for the Node app
log "Creating app systemd service..."
cat > /etc/systemd/system/agent-services-app.service << EOF
[Unit]
Description=vers-agent-services Node.js app
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
Environment=PORT=${APP_PORT}
Environment=NODE_ENV=production
EnvironmentFile=-/etc/agent-services.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30

# Graceful shutdown: let existing requests drain
KillMode=mixed

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-services

[Install]
WantedBy=multi-user.target
EOF

# Step 6: Create env file (if not exists)
if [ ! -f /etc/agent-services.env ]; then
  log "Creating /etc/agent-services.env..."
  cat > /etc/agent-services.env << EOF
# Agent-services environment variables
# VERS_AUTH_TOKEN should be set here for production
VERS_AUTH_TOKEN=${VERS_AUTH_TOKEN:-}
PORT=${APP_PORT}
EOF
  log "  Edit /etc/agent-services.env to set VERS_AUTH_TOKEN"
else
  log "/etc/agent-services.env already exists, not overwriting"
fi

# Step 7: Migrate from old setup
# If something is currently running on port 3000 (old direct setup), stop it
OLD_PID=$(ss -tlnp | grep ':3000 ' | grep -oP 'pid=\K\d+' | head -1 || true)
if [ -n "$OLD_PID" ]; then
  PROC_NAME=$(cat /proc/$OLD_PID/comm 2>/dev/null || echo "unknown")
  if [ "$PROC_NAME" = "node" ]; then
    warn "Found old Node process on port 3000 (PID: $OLD_PID). Stopping..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# Step 8: Build the app (if not already built)
cd "$REPO_DIR"
if [ ! -f dist/server.js ]; then
  log "Building app..."
  npm install
  npm run build
fi

# Step 9: Enable and start services
log "Starting services..."
systemctl daemon-reload
systemctl enable agent-services-caddy agent-services-app
systemctl start agent-services-app
sleep 2

# Verify app is up before starting caddy
if curl -sf "http://localhost:${APP_PORT}/health" > /dev/null 2>&1; then
  log "App is healthy on port ${APP_PORT}"
else
  warn "App health check failed — check: journalctl -u agent-services-app"
fi

systemctl start agent-services-caddy
sleep 1

# Step 10: Verify end-to-end
if curl -sf "http://localhost:3000/health" > /dev/null 2>&1; then
  log "✅ Zero-downtime setup complete!"
  log "  Caddy: :3000 (reverse proxy)"
  log "  App:   :${APP_PORT} (Node.js)"
  log ""
  log "  Deploy: ./scripts/deploy-zero-downtime.sh [branch]"
  log "  Logs:   journalctl -u agent-services-app -f"
  log "  Caddy:  journalctl -u agent-services-caddy -f"
else
  fail "End-to-end health check failed. Debug with:"
  echo "  journalctl -u agent-services-caddy -n 20"
  echo "  journalctl -u agent-services-app -n 20"
fi
