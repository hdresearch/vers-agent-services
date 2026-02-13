---
name: deploy
description: Deploy agent-services to the infra VM. Use when shipping new code, restarting services, or rolling back a broken deploy. Covers pre-deploy snapshot, pull/build/restart, smoke tests, and rollback.
---

# Deploy Runbook

Step-by-step procedure for deploying agent-services to the infra VM. Follow this exactly — skipping steps has caused real incidents (unauthenticated servers, unrecoverable state).

## When to Use

- **Shipping new features** — after a PR merges to main
- **Hotfixing a broken service** — pull the fix, rebuild, restart
- **Rolling back** — restore from pre-deploy snapshot
- **Restarting after a crash** — same process minus the git pull

## Prerequisites

You need:
- The infra VM ID (check the registry or ask the orchestrator)
- The `VERS_AUTH_TOKEN` value (check with the orchestrator — if lost, all agents need reconfiguration)
- SSH access to the VM (`root@{VM_ID}.vm.vers.sh`)

## Step 1: Snapshot the Infra VM

**Do this FIRST. Every time. No exceptions.**

Before touching anything, snapshot the current state so you can roll back:

```bash
# From the orchestrator or any agent with vers tools
vers_vm_commit --vmId {INFRA_VM_ID}
# → returns a commit ID, e.g., "commit-abc123"
```

Record the commit in the ledger (if the service is still running):

```bash
curl -X POST "http://{INFRA_VM_ID}.vm.vers.sh:3000/commits" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "commitId": "commit-abc123",
    "vmId": "{INFRA_VM_ID}",
    "label": "pre-deploy-backup",
    "agent": "your-agent-name",
    "tags": ["backup", "infra", "pre-deploy"]
  }'
```

**Save the commit ID.** You will need it if the deploy goes wrong.

## Step 2: SSH into the Infra VM

```bash
ssh -o StrictHostKeyChecking=no root@{INFRA_VM_ID}.vm.vers.sh
```

## Zero-Downtime Deploy (Preferred)

If the zero-downtime setup has been configured (Caddy + systemd), use the automated script:

```bash
cd /root/workspace/vers-agent-services
./scripts/deploy-zero-downtime.sh [branch]
```

This script:
1. Pulls latest code from the specified branch
2. Installs dependencies and builds
3. Gracefully restarts the app (SIGTERM → drain → start new)
4. Caddy holds all connections during the restart gap
5. Health checks the new process
6. Zero dropped requests

### First-time setup

If zero-downtime has not been set up yet on the infra VM:

```bash
cd /root/workspace/vers-agent-services
./scripts/setup-zero-downtime.sh
```

This installs Caddy, creates systemd services, and configures the proxy.

### Architecture

```
Clients → :3000 (Caddy reverse proxy) → :3001 (Node.js app)
```

- **Caddy** runs on port 3000 (the public port). It never restarts during deploys.
- **App** runs on port 3001 (configurable via `APP_PORT`). It restarts during deploys.
- During the restart gap (~2-3s), Caddy retries connections to the upstream.
- The app handles SIGTERM gracefully (drains in-flight requests before exiting).

### Testing

```bash
./scripts/test-zero-downtime.sh
```

Runs continuous requests through Caddy while restarting the app, verifying zero dropped requests.

## Legacy Deploy (Manual)

If zero-downtime is not set up, fall back to the manual process:

### Step 3: Pull Latest Code

```bash
cd /root/workspace/vers-agent-services
git fetch origin
git checkout main
git reset --hard origin/main
```

Using `reset --hard` ensures a clean state — no merge conflicts, no stale local changes.

### Step 4: Install and Build

```bash
npm install
npm run build
```

Watch for errors. If `npm run build` (TypeScript compilation) fails, **do not proceed** — the deploy will serve stale code from the old `dist/`.

### Step 5: Restart the Server

Kill the old process and start a new one with the required env vars:

```bash
# Stop the running server
kill -9 $(ss -tlnp | grep 3000 | grep -oP 'pid=\K\d+') 2>/dev/null; sleep 2

# Start with required env vars
export VERS_AUTH_TOKEN=<token>
nohup env VERS_AUTH_TOKEN=$VERS_AUTH_TOKEN node dist/server.js > /tmp/agent-services.log 2>&1 &

# Verify it started
sleep 2
cat /tmp/agent-services.log
```

You should see: `vers-agent-services running on :3000`

⚠️ **Note:** This method causes brief downtime during the restart. Prefer the zero-downtime deploy above.

## Step 6: Smoke Test

### Health check (no auth required)

```bash
curl -s http://localhost:3000/health
```

Expected: `{"status":"ok","uptime":...}`

### Spot-check endpoints (auth required)

```bash
# Board
curl -s -H "Authorization: Bearer $VERS_AUTH_TOKEN" http://localhost:3000/board/tasks | head -c 200

# Feed
curl -s -H "Authorization: Bearer $VERS_AUTH_TOKEN" http://localhost:3000/feed/events | head -c 200

# Registry
curl -s -H "Authorization: Bearer $VERS_AUTH_TOKEN" http://localhost:3000/registry/vms | head -c 200

# Commits
curl -s -H "Authorization: Bearer $VERS_AUTH_TOKEN" http://localhost:3000/commits | head -c 200
```

Each should return JSON with the expected structure. If any returns `401`, the auth token is correct (middleware is working). If any returns nothing or errors, check the logs:

```bash
tail -50 /tmp/agent-services.log
# or with systemd:
journalctl -u agent-services-app -n 50
```

### Verify from outside the VM

From the orchestrator or another agent, test the external URL:

```bash
curl -s -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  http://{INFRA_VM_ID}.vm.vers.sh:3000/health
```

## Step 7: Post-Deploy

- Record the successful deploy in the feed
- Snapshot the new working state (another `vers_vm_commit`) and record it with a `post-deploy` tag
- Verify agents can still reach the board, feed, and registry

## Rollback Procedure

If the deploy is broken:

### Option A: Restore from Snapshot (clean rollback)

```bash
# From the orchestrator (not from the broken VM)
vers_vm_restore --commitId {PRE_DEPLOY_COMMIT_ID}
# → creates a new VM with the old state
# Update DNS/references to point to the new VM ID
```

This gives you a brand new VM with the exact pre-deploy state. The old broken VM can be deleted.

### Option B: Git Revert (if the VM is still accessible)

```bash
ssh -o StrictHostKeyChecking=no root@{INFRA_VM_ID}.vm.vers.sh
cd /root/workspace/vers-agent-services
git log --oneline -5  # find the last known good commit
git reset --hard {GOOD_COMMIT_SHA}
npm install && npm run build

# With zero-downtime setup:
./scripts/deploy-zero-downtime.sh

# Without:
kill -9 $(ss -tlnp | grep 3000 | grep -oP 'pid=\K\d+') 2>/dev/null; sleep 2
nohup env VERS_AUTH_TOKEN=$VERS_AUTH_TOKEN node dist/server.js > /tmp/agent-services.log 2>&1 &
```

## Common Pitfalls

### ❌ Forgetting VERS_AUTH_TOKEN

**What happens:** The server starts but with no auth — all endpoints are open to anyone. You'll see this warning in the logs:

```
⚠️  VERS_AUTH_TOKEN is not set — all endpoints are unauthenticated.
```

**Fix:** Kill the server, set the env var, restart. Or set it in `/etc/agent-services.env`.

### ❌ Forgetting to Snapshot First

**What happens:** If the deploy breaks, you have no rollback point. You're stuck debugging a broken VM under pressure.

**Fix:** Always snapshot before deploying. Make it muscle memory. The commit ledger exists precisely for this.

### ❌ Stale dist/ Files

**What happens:** `npm run build` fails but you restart anyway. The server runs old compiled code from `dist/`, which may not match the new source. Subtle bugs ensue.

**Fix:** Never restart after a failed build. Fix the build error first, or roll back. The zero-downtime deploy script aborts on build failure automatically.

### ❌ Port Already in Use

**What happens:** `pkill` didn't fully kill the old process. The new server fails to bind.

**Fix:**
```bash
# Find what's using the port
ss -tlnp | grep :3001
# Force kill
kill -9 $(ss -tlnp | grep :3001 | grep -oP 'pid=\K\d+')
sleep 1
```

### ❌ Deploying Without Testing

**What happens:** You push untested code and deploy it. The build passes but runtime errors break endpoints.

**Fix:** Always run `npm test` locally (or on a branch VM) before deploying. The infra VM is shared — breaking it affects all agents.

### ❌ Data File Permissions / Missing Directories

**What happens:** The server crashes on first write because `data/` doesn't exist or has wrong permissions.

**Fix:** The stores auto-create directories, but if you see file permission errors:
```bash
mkdir -p /root/workspace/vers-agent-services/data
chmod 755 /root/workspace/vers-agent-services/data
```
