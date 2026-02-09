# vers-agent-services

A userspace coordination layer for AI agent swarms on [Vers](https://vers.sh). Not a platform requirement — an optional package that makes multi-agent work better by providing shared task tracking, real-time event streaming, service discovery, and centralized skill management.

Install it as a [pi](https://github.com/mariozechner/pi-coding-agent) package:

```bash
pi install https://github.com/hdresearch/vers-agent-services
```

This gives your agents tools (`board_create_task`, `feed_publish`, `registry_discover`, etc.) and automatic behaviors (self-registration, heartbeat, lifecycle events) — no manual wiring needed.

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

Agents automatically register in the registry, publish lifecycle events to the feed, and send heartbeats — all without any manual setup.

## Architecture

A single Hono HTTP server runs on one "infra VM". All agent VMs communicate with it over HTTP. A pi extension wraps the API into tools and handles automatic behaviors.

```
┌──────────────────────────────────────┐
│  Infra VM (:3000)                    │
│  ├── /board/*     Task tracking      │
│  ├── /feed/*      Activity stream    │
│  ├── /registry/*  Service discovery  │
│  ├── /skills/*    SkillHub registry  │
│  ├── /ui/*        Web dashboard      │
│  └── /health      Liveness probe     │
└──────────────────────────────────────┘
        ▲       ▲       ▲       ▲
    Agent-1  Agent-2  Agent-3  Orchestrator
    (worker) (worker) (worker)  (pi)
```

**Components:**
- **Server** — Hono app with board, feed, registry, and skills services (in-memory + JSONL persistence)
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

Task statuses: `open`, `in_progress`, `blocked`, `done`
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

## Web UI

A dashboard is served at `/ui/` providing a 3-panel view of the coordination layer:
- **Board** — task list with status, assignee, and tags
- **Feed** — live activity stream (auto-updates via SSE)
- **Registry** — registered VMs with status and heartbeat info

### Authentication

The UI uses magic link authentication:

```bash
# Generate a magic link (server-side)
curl -X POST http://infra-vm:3000/auth/magic-link \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json"
```

The returned URL can be opened in a browser to authenticate into the dashboard.

## Authentication

All endpoints except `/health` are protected by bearer token auth when `VERS_AUTH_TOKEN` is set.

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

## Automatic Behaviors

The extension performs these actions automatically — no agent code needed:

| Behavior | Trigger | Detail |
|----------|---------|--------|
| **Publish `agent_started`** | `agent_start` lifecycle hook | Posts to feed with agent name |
| **Publish `agent_stopped`** | `agent_end` lifecycle hook | Posts to feed with agent name |
| **Registry self-registration** | `agent_start` lifecycle hook | Registers VM using `VERS_VM_ID`, role from `VERS_AGENT_ROLE` (default: `worker`) |
| **Heartbeat** | Every 60 seconds | Keeps registry entry alive via `POST /registry/vms/:id/heartbeat` |
| **Registry status update** | `agent_end` lifecycle hook | Sets VM status to `stopped` |
| **Status widget** | `session_start` + every 30s | Shows board/feed/registry summary in pi TUI |

Agent name is derived from `VERS_AGENT_NAME` (falls back to `agent-<pid>`).

## Skills

The package includes these skills (available to agents after install):

| Skill | Description |
|-------|-------------|
| `board` | Task board usage patterns, API reference, common workflows |
| `feed` | Activity feed patterns, SSE streaming, event types reference |
| `registry` | Service discovery, heartbeat patterns, self-registration |
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
