# vers-agent-services

A userspace coordination layer for AI agent swarms on [Vers](https://vers.sh). Not a platform requirement — an optional package that makes multi-agent work better by providing shared task tracking, real-time event streaming, service discovery, work logging, usage tracking, and centralized skill management.

Install it as a [pi](https://github.com/mariozechner/pi-coding-agent) package:

```bash
pi install https://github.com/hdresearch/vers-agent-services
```

This gives your agents tools (`board_create_task`, `feed_publish`, `log_append`, `usage_summary`, etc.) and automatic behaviors (self-registration, heartbeat, lifecycle events, usage tracking) — no manual wiring needed.

## Quick Start

### 1. Deploy the server to a Vers VM

```bash
# Create and set up an infra VM
vers_vm_create        # → vm-abc123
vers_vm_use vm-abc123

# Clone and start the server
git clone https://github.com/hdresearch/vers-agent-services.git
cd vers-agent-services
npm install
VERS_AUTH_TOKEN=$(openssl rand -hex 32) PORT=3000 npm start
```

### 2. Configure agents

Set these environment variables on every agent VM:

```bash
export VERS_INFRA_URL=http://vm-abc123.vm.vers.sh:3000
export VERS_AUTH_TOKEN=<same token as the server>
export VERS_VM_ID=<this VM's Vers ID>
export VERS_AGENT_NAME=worker-auth
export VERS_AGENT_ROLE=worker
```

### 3. Install the package on agents

```bash
pi install https://github.com/hdresearch/vers-agent-services
```

Agents automatically register in the registry, publish lifecycle events to the feed, track token usage, and send heartbeats — all without any manual setup.

## Architecture

A single Hono HTTP server runs on one "infra VM". All agent VMs communicate with it over HTTP. A pi extension wraps the API into tools and handles automatic behaviors.

```
┌─────────────────────────────────────────┐
│  Infra VM (:3000)                       │
│  ├── /board/*      Task tracking        │
│  ├── /feed/*       Activity stream      │
│  ├── /log/*        Work log             │
│  ├── /journal/*    Personal journal     │
│  ├── /registry/*   Service discovery    │
│  ├── /skills/*     SkillHub registry    │
│  ├── /reports/*    Reports + sharing    │
│  ├── /commits/*    Commit ledger        │
│  ├── /usage/*      Cost tracking        │
│  ├── /ui/*         Web dashboard        │
│  ├── /auth/*       Magic link auth      │
│  └── /health       Liveness probe       │
└─────────────────────────────────────────┘
        ▲       ▲       ▲       ▲
    Agent-1  Agent-2  Agent-3  Orchestrator
    (worker) (worker) (worker)  (pi)
```

**Components:**
- **Server** — Hono app with 9 service modules: board, feed, log, journal, registry, skills, reports, commits, and usage
- **Storage** — JSONL for board/feed/log/journal/registry, SQLite for commits, DuckDB for usage
- **Pi extension** (`extensions/agent-services.ts`) — registers tools and handles auto-behaviors
- **Skills** (`skills/`) — coordination protocols agents can reference

## Services

### Board — Shared Task Tracking

Agents create tasks, claim them, post notes with findings/blockers, and mark them done.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/board/tasks` | `POST` | Create a task |
| `/board/tasks` | `GET` | List tasks (filter: `?status=`, `?assignee=`, `?tag=`) |
| `/board/tasks/:id` | `GET` | Get a single task |
| `/board/tasks/:id` | `PATCH` | Update task (status, assignee, title, tags) |
| `/board/tasks/:id` | `DELETE` | Delete a task |
| `/board/tasks/:id/notes` | `POST` | Add a note (finding, blocker, question, update) |
| `/board/tasks/:id/notes` | `GET` | List notes for a task |

Task statuses: `open`, `in_progress`, `in_review`, `blocked`, `done`
Note types: `finding`, `blocker`, `question`, `update`

### Feed — Activity Event Stream

Real-time event stream for coordination and observability. Supports SSE for live tailing.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/feed/events` | `POST` | Publish an event |
| `/feed/events` | `GET` | List events (filter: `?agent=`, `?type=`, `?since=`, `?limit=`) |
| `/feed/events/:id` | `GET` | Get a single event |
| `/feed/events` | `DELETE` | Clear all events |
| `/feed/stats` | `GET` | Summary stats (total, by agent, by type) |
| `/feed/stream` | `GET` | SSE stream (filter: `?agent=`, reconnect: `?since=<ulid>`) |

Event types: `task_started`, `task_completed`, `task_failed`, `blocker_found`, `question`, `finding`, `skill_proposed`, `file_changed`, `cost_update`, `agent_started`, `agent_stopped`, `custom`

### Log — Append-Only Work Log

Carmack `.plan`-style work log. Timestamped, append-only, JSONL-backed. For operational records — what happened, what was decided, what's next.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/log` | `POST` | Append an entry (`{ text, agent? }`) |
| `/log` | `GET` | Query entries (filter: `?since=`, `?until=`, `?last=`) |
| `/log/raw` | `GET` | Query entries as plain text (same filters) |

### Journal — Personal Narrative Log

Separate from operational logs. For thoughts, vibes, product intuitions, feelings. Supports mood tags and categorization.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/journal` | `POST` | Write an entry (`{ text, author, mood?, tags? }`) |
| `/journal` | `GET` | Query entries (filter: `?since=`, `?until=`, `?last=`, `?author=`, `?tag=`, `?raw=true`) |
| `/journal/raw` | `GET` | Query entries as plain text (same filters) |

### Registry — VM Service Discovery

Agents register themselves so others can discover them by role. Includes heartbeat for liveness detection.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/registry/vms` | `POST` | Register a VM |
| `/registry/vms` | `GET` | List VMs (filter: `?role=`, `?status=`) |
| `/registry/vms/:id` | `GET` | Get a single VM |
| `/registry/vms/:id` | `PATCH` | Update a VM (status, address, metadata) |
| `/registry/vms/:id` | `DELETE` | Deregister a VM |
| `/registry/vms/:id/heartbeat` | `POST` | Send heartbeat (updates `lastSeen`) |
| `/registry/discover/:role` | `GET` | Discover running, non-stale VMs by role |

VM roles: `infra`, `lieutenant`, `worker`, `golden`, `custom`
Stale threshold: 5 minutes without heartbeat → excluded from `discover` and `?status=running`

### SkillHub — Skill & Extension Registry

Central registry for managing skills and extensions across an agent fleet. Agents sync from the hub on startup and receive live updates via SSE.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/skills/items` | `POST` | Publish or update a skill (upsert by name) |
| `/skills/items` | `GET` | List skills (filter: `?tag=`, `?enabled=`) |
| `/skills/items/:name` | `GET` | Get a skill by name |
| `/skills/items/:name` | `PATCH` | Update skill metadata |
| `/skills/items/:name` | `DELETE` | Delete a skill |
| `/skills/extensions` | `POST` | Publish or update an extension |
| `/skills/extensions` | `GET` | List extensions |
| `/skills/extensions/:name` | `GET` | Get an extension by name |
| `/skills/extensions/:name` | `DELETE` | Delete an extension |
| `/skills/manifest` | `GET` | Get current manifest of all enabled skills + extensions |
| `/skills/sync` | `POST` | Agent reports installed state, gets back needed updates |
| `/skills/stream` | `GET` | SSE stream of skill/extension changes (reconnect: `?since=<ulid>`) |
| `/skills/agents` | `GET` | List all agents and their sync manifests |
| `/skills/agents/:agentId` | `GET` | Get a specific agent's manifest |

### Reports — Markdown Reports with Sharing

Create structured reports and share them with external stakeholders via public share links.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/reports` | `POST` | Create a report (`{ title, author, content, tags? }`) |
| `/reports` | `GET` | List reports (filter: `?author=`, `?tag=`) |
| `/reports/:id` | `GET` | Get a single report |
| `/reports/:id` | `DELETE` | Delete a report |
| `/reports/:id/share` | `POST` | Create a share link (`{ createdBy, expiresAt?, label? }`) |
| `/reports/:id/shares` | `GET` | List share links for a report |
| `/reports/share/:linkId` | `DELETE` | Revoke a share link |
| `/reports/share/:linkId/access` | `GET` | View access log for a share link |
| `/reports/share/:linkId` | `GET` | **Public** — view shared report (no auth required) |

### Commits — VM Snapshot Ledger

Tracks Vers VM commits (golden images, infra snapshots, rollback points). SQLite-backed.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/commits` | `POST` | Record a commit (`{ commitId, vmId, label?, agent?, tags? }`) |
| `/commits` | `GET` | List commits (filter: `?tag=`, `?agent=`, `?label=`, `?since=`, `?vmId=`) |
| `/commits/:id` | `GET` | Get a commit by commitId |
| `/commits/:id` | `DELETE` | Remove a commit entry |

### Usage — Cost & Token Tracking

Tracks token usage, cost, and VM lifecycle across the agent fleet. DuckDB-backed for efficient aggregation.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/usage` | `GET` | Usage summary (filter: `?range=7d`) |
| `/usage/sessions` | `POST` | Record a session (auto-posted by extension on agent_end) |
| `/usage/sessions` | `GET` | List sessions (filter: `?agent=`, `?range=`) |
| `/usage/vms` | `POST` | Record a VM lifecycle event |
| `/usage/vms` | `GET` | List VM records (filter: `?role=`, `?agent=`, `?range=`) |

## Web UI

A dashboard is served at `/ui/` with 3 tabs:
- **Dashboard** — board tasks, feed stream (live via SSE), registry status
- **Log** — work log entries
- **Journal** — personal journal entries

### Authentication

The UI uses magic link authentication:

```bash
# Generate a magic link (requires bearer auth)
curl -X POST http://infra-vm:3000/auth/magic-link \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

The returned URL can be opened in a browser. The UI proxies API requests through `/ui/api/*`, injecting the bearer token server-side so the browser never needs it.

## Authentication

> **Detailed docs:** See [`docs/auth.md`](docs/auth.md) for the full auth flow — bearer tokens, magic links, session cookies, and the UI API proxy.

All API endpoints are protected by bearer token auth when `VERS_AUTH_TOKEN` is set. Exceptions:
- `/health` — always open (liveness probe)
- `/reports/share/:linkId` — public share links (no auth)

```bash
# Start server with auth
VERS_AUTH_TOKEN=$(openssl rand -hex 32) npm start

# Authenticated request
curl -H "Authorization: Bearer $VERS_AUTH_TOKEN" http://infra-vm:3000/board/tasks

# Health check — always unauthenticated
curl http://infra-vm:3000/health
```

**Backwards compatible:** If `VERS_AUTH_TOKEN` is not set, the server runs in dev mode with all endpoints open (a warning is logged at startup). For production, always set the token — all Vers VM ports are public.

The pi extension automatically includes the token from the `VERS_AUTH_TOKEN` environment variable on all API calls.

## Extension Tools

When installed via `pi install`, the extension registers these tools:

### Board Tools
| Tool | Description |
|------|-------------|
| `board_create_task` | Create a task (title, description, assignee, tags, createdBy) |
| `board_list_tasks` | List/filter tasks (status, assignee, tag) |
| `board_update_task` | Update task (status, assignee, title, tags) |
| `board_add_note` | Add a note to a task (finding, blocker, question, update) |

### Log Tools
| Tool | Description |
|------|-------------|
| `log_append` | Append a timestamped work log entry |
| `log_query` | Query log entries by time range, with optional raw text output |

### Journal Tools
| Tool | Description |
|------|-------------|
| `journal_entry` | Write a personal journal entry with optional mood/tags |

### Feed Tools
| Tool | Description |
|------|-------------|
| `feed_publish` | Publish an event (agent, type, summary, detail) |
| `feed_list` | List/filter events (agent, type, limit) |
| `feed_stats` | Get activity summary statistics |

### Registry Tools
| Tool | Description |
|------|-------------|
| `registry_register` | Register a VM in the registry |
| `registry_list` | List/filter registered VMs |
| `registry_discover` | Discover VMs by role |
| `registry_heartbeat` | Send a heartbeat for a VM |

### SkillHub Tools
| Tool | Description |
|------|-------------|
| `skillhub_sync` | Pull latest skills and extensions from the SkillHub |

### Usage Tools
| Tool | Description |
|------|-------------|
| `usage_summary` | Get cost & token usage summary across the fleet |
| `usage_sessions` | List session usage records (tokens, cost, turns, tool calls) |
| `usage_vms` | List VM lifecycle records (creation, commit, destruction) |

## Automatic Behaviors

The extension performs these actions automatically — no agent code needed:

| Behavior | Trigger | Detail |
|----------|---------|--------|
| **Publish `agent_started`** | `agent_start` lifecycle hook | Posts to feed with agent name |
| **Publish `agent_stopped`** | `agent_end` lifecycle hook | Posts to feed with turn count, tokens, and cost |
| **Registry self-registration** | `agent_start` lifecycle hook | Registers VM using `VERS_VM_ID`, role from `VERS_AGENT_ROLE` (default: `worker`) |
| **Heartbeat** | Every 60 seconds | Keeps registry entry alive via `POST /registry/vms/:id/heartbeat` |
| **Registry status update** | `agent_end` lifecycle hook | Sets VM status to `stopped` |
| **Usage tracking** | Every turn + `agent_end` | Accumulates tokens, cost, tool calls; posts session summary on end |
| **VM lifecycle tracking** | `tool_result` for vers_vm_* tools | Records VM create/commit/delete events to `/usage/vms` |
| **SkillHub sync** | `session_start` + `turn_start` (60s cooldown) | Syncs skills/extensions from hub; subscribes to SSE for live updates |
| **Status widget** | `session_start` + every 30s | Shows board/feed/registry summary in pi TUI |

Agent name is derived from `VERS_AGENT_NAME` (falls back to `agent-<pid>`).

## Skills

The package includes these skills (available to agents after install):

| Skill | Description |
|-------|-------------|
| `board` | Task board usage patterns, API reference, common workflows |
| `feed` | Activity feed patterns, SSE streaming, event types reference |
| `log` | Work log patterns, querying, raw output for piping into models |
| `registry` | Service discovery, heartbeat patterns, self-registration |
| `reports` | Creating reports, generating share links, access tracking |
| `commits` | Commit ledger for tracking VM snapshots |
| `deploy` | Deploying agent-services: pre-deploy snapshot, pull/build/restart, rollback |
| `recovery` | Protocol for recovering orchestrator state after session loss |
| `swarm-coordination` | Full multi-agent orchestration workflow combining all services |

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `DATA_DIR` | `./data` | Persistent storage directory |
| `VERS_AUTH_TOKEN` | _(none)_ | Bearer token for API auth. If unset, dev mode (no auth). |

### Agents (extension)

| Variable | Default | Description |
|----------|---------|-------------|
| `VERS_INFRA_URL` | _(required)_ | Base URL of the agent-services server (e.g., `http://vm-abc123.vm.vers.sh:3000`) |
| `VERS_AUTH_TOKEN` | _(none)_ | Bearer token — must match the server's token |
| `VERS_VM_ID` | _(none)_ | This VM's Vers ID. Enables auto-registration and heartbeat. |
| `VERS_AGENT_NAME` | `agent-<pid>` | Human-readable agent name for feed events and registry |
| `VERS_AGENT_ROLE` | `worker` | Role for registry registration (`infra`, `lieutenant`, `worker`, `golden`, `custom`) |
| `VERS_PARENT_AGENT` | _(none)_ | Parent agent name (included in usage session records) |

## Development

```bash
git clone https://github.com/hdresearch/vers-agent-services.git
cd vers-agent-services
npm install
npm run dev       # development with hot reload
npm run build     # compile TypeScript
npm start         # production
npm test          # run tests
```

## License

MIT
