# vers-agent-services

Lightweight coordination services for Vers agent swarms. A single HTTP server providing shared infrastructure that multiple AI agents use to coordinate work.

## Services

| Service | Port/Path | Purpose |
|---------|-----------|---------|
| **Board** | `/board/*` | Shared task/issue tracker — agents create, claim, and update tasks |
| **Feed** | `/feed/*` | Real-time activity stream — agents publish events, orchestrator tails |
| **Skills** | `/skills/*` | Skill proposal registry — agents propose, orchestrator approves |
| **Context** | `/context/*` | Shared knowledge base — agents write learnings, others query |
| **Cost** | `/cost/*` | Budget tracking — aggregated token usage across all agents |

## Architecture

Single Hono server on one "infra VM". All agent VMs communicate via HTTP.

```
┌─────────────────────────┐
│  Infra VM (:3000)       │
│  └── /board  /feed      │
│      /skills /context   │
│      /cost              │
└─────────────────────────┘
     ▲   ▲   ▲   ▲
   Agent Agent Agent Orchestrator
```

## Quick Start

```bash
npm install
npm run dev       # development with hot reload
npm run build     # compile TypeScript
npm start         # production
```

## Agent Integration

Agents interact via HTTP. A pi extension wraps these into tools:

```bash
# Create a task
curl -X POST http://infra-vm:3000/board/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Implement auth flow", "assignee": "agent-1"}'

# Publish an event
curl -X POST http://infra-vm:3000/feed/events \
  -H 'Content-Type: application/json' \
  -d '{"agent": "agent-1", "type": "task_completed", "summary": "Auth flow done"}'

# Tail the feed (SSE)
curl http://infra-vm:3000/feed/stream
```

## Authentication

All endpoints (except `/health`) are protected by bearer token auth when `VERS_AUTH_TOKEN` is set.

```bash
# Start server with auth enabled
VERS_AUTH_TOKEN=$(openssl rand -hex 32) npm start

# Authenticated request
curl -H "Authorization: Bearer $VERS_AUTH_TOKEN" http://infra-vm:3000/board/tasks

# Health check — always unauthenticated
curl http://infra-vm:3000/health
```

If `VERS_AUTH_TOKEN` is **not set**, the server runs in dev mode with no auth (a warning is logged).

For agent swarms, pass the same token to both the infra VM and all worker VMs via environment variable. The pi extension (`agent-services.ts`) automatically sends the token from `VERS_AUTH_TOKEN` on all API calls.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `./data` | Persistent storage directory |
| `VERS_AUTH_TOKEN` | _(none)_ | Bearer token for API auth. If unset, all endpoints are open. |
