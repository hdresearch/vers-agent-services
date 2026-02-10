---
name: swarm-coordination
description: Orchestrate multi-agent swarms using Vers VMs with board, feed, and registry coordination. Use when spinning up swarms, assigning tasks, monitoring progress, or recovering from session drops.
---

# Swarm Coordination

Use this skill when orchestrating a multi-agent swarm using Vers VMs. It combines the **Vers swarm tools** (from pi-v) with the **agent services tools** (board, feed, registry) into a unified coordination workflow.

## The Full Toolkit

You have access to three categories of tools:

### Vers VM & Swarm Tools (from pi-v)
- `vers_vm_create`, `vers_vm_commit`, `vers_vm_restore` — VM lifecycle
- `vers_swarm_spawn` — Branch VMs and start pi agents
- `vers_swarm_task` — Send tasks to agents
- `vers_swarm_status` — Check agent status
- `vers_swarm_read` — Read agent output
- `vers_swarm_wait` — Block until agents finish
- `vers_swarm_teardown` — Destroy swarm VMs

### Board Tools (coordination)
- `board_create_task` — Track work items
- `board_list_tasks` — Query task status
- `board_update_task` — Update status/assignee
- `board_add_note` — Attach findings, blockers, questions

### Feed & Registry Tools (observability)
- `feed_publish` — Emit events for audit trail
- `feed_list` — Query activity history
- `feed_stats` — Get summary metrics
- `registry_register` — Register VMs for discovery
- `registry_discover` — Find agents by role
- `registry_heartbeat` — Keep registrations alive
- `registry_list` — List all registered VMs

### SkillHub (fleet-wide skill management)
The infra server includes a SkillHub at `/skills/*` for centrally managing skills and extensions across all agents. The extension automatically syncs skills from the hub to `~/.pi/agent/skills/_hub/` on session start and subscribes to SSE for live updates. This is handled transparently — agents don't need to interact with SkillHub directly unless publishing new skills.

## Environment Variables Agents Receive

When spawned via `vers_swarm_spawn`, agents get these env vars:
- `ANTHROPIC_API_KEY` — for LLM calls
- `VERS_API_KEY` — for Vers API
- `VERS_INFRA_URL` — coordination services URL
- `VERS_AUTH_TOKEN` — auth token for coordination services
- `VERS_VM_ID` — this VM's ID (for self-registration)
- `VERS_AGENT_ROLE` — agent's role (worker, lieutenant, etc.)
- `VERS_AGENT_NAME` — agent's label/name

The agent-services extension automatically:
- Publishes `agent_started`/`agent_stopped` to the feed
- Registers the agent in the registry on startup (using `VERS_VM_ID`)
- Sends periodic heartbeats (every 60s) to keep registry entry alive
- Updates registry status to `stopped` on shutdown

This means **you don't need to manually register swarm agents** — they self-register the moment they boot. You only need to register VMs created outside the extension (e.g., infra VMs).

## Recommended Workflow

Follow this sequence when spinning up a coordinated swarm:

### 1. Assess the Environment

```
registry_list {}                    # What's already running?
board_list_tasks { status: "open" } # Any pending work?
feed_list { limit: 10 }            # Recent activity?
```

### 2. Create Board Tasks

Break the work into discrete, parallelizable tasks. Each task should be independently completable.

```
board_create_task {
  title: "Implement user auth module",
  description: "Create JWT-based auth with refresh tokens. Files: src/auth/...",
  tags: ["feature", "auth", "sprint-1"],
  createdBy: "coordinator"
}
```

**Task decomposition rules:**
- Each task should take 5–20 minutes for an agent
- Include specific file paths and acceptance criteria in the description
- Tag tasks for the feature area they belong to
- If tasks have dependencies, note them in the description (don't rely on ordering)

### 3. Spawn the Swarm

```
vers_swarm_spawn {
  commitId: "<golden-image-commit>",
  count: 3,
  labels: ["auth", "api", "tests"],
  anthropicApiKey: "<key>"
}
```

### 4. Verify Agent Registration

Agents self-register automatically on boot (via the extension). Verify they've checked in:

```
registry_list { status: "running", role: "worker" }
```

If an agent hasn't appeared after ~10s, check `feed_list` for its `agent_started` event or `vers_swarm_status` for errors.

### 5. Assign Tasks

Update board tasks with assignees and dispatch work:

```
board_update_task { id: "<task-id>", status: "in_progress", assignee: "worker-auth" }
vers_swarm_task { agentId: "auth", task: "..." }
```

**In the task prompt, tell the agent:**
- What board task ID it's working on
- To use `feed_publish` for progress updates
- To use `board_add_note` for findings/blockers
- To update the task status when done

### 6. Monitor Progress

Poll the feed and board while agents work:

```
feed_list { limit: 20 }              # Check for blockers or questions
board_list_tasks { status: "blocked" } # Any stuck tasks?
vers_swarm_status {}                   # Are agents still working?
```

If an agent reports a blocker:
1. Check the board note for details
2. Steer the agent or reassign the task
3. Publish a feed event about the resolution

### 7. Collect Results

```
vers_swarm_wait { timeoutSeconds: 600 }  # Wait for all agents
```

Then for each agent:
```
vers_swarm_read { agentId: "auth" }
board_update_task { id: "<task-id>", status: "done" }
feed_publish { agent: "coordinator", type: "task_completed", summary: "Auth module complete" }
```

### 8. Clean Up

⚠️ **`vers_swarm_teardown` destroys ALL swarm VMs.** The infra VM must NOT be part of the swarm — see Pitfalls below.

```
vers_swarm_teardown {}
feed_publish { agent: "coordinator", type: "agent_stopped", summary: "Swarm teardown complete" }
```

## Recovery Pattern

If a coordinator session drops (disconnect, crash, compaction), follow the **recovery skill** (`skills/recovery/SKILL.md`) for the full protocol. Quick summary:

1. `registry_list { status: "running" }` — find active VMs
2. `board_list_tasks {}` — find all work items by status
3. `feed_list { limit: 50 }` — understand what happened
4. Cross-reference: are `in_progress` task assignees still in the registry?
5. Re-assign orphaned tasks, resolve blockers, spawn replacements
6. `feed_publish` a recovery event

Since agents auto-register and heartbeat, the registry is your source of truth for what's alive. VMs missing heartbeats for 5+ min are stale and excluded from `registry_discover`.

## Conventions

### Agent Naming
- **Coordinator**: `coordinator` or `coordinator-<project>`
- **Lieutenants**: `lt-<domain>` (e.g., `lt-backend`, `lt-frontend`)
- **Workers**: `worker-<label>` (e.g., `worker-auth`, `worker-api`)
- Names should be stable across sessions for feed/board traceability

### Task Tagging
- Feature area: `auth`, `api`, `ui`, `infra`
- Task type: `feature`, `bugfix`, `test`, `refactor`, `docs`
- Priority: `p0`, `p1`, `p2`
- Sprint/batch: `sprint-1`, `batch-2`

### Feed Event Types
Use consistently across all agents:

| Type | When |
|------|------|
| `agent_started` | Agent begins work (auto-published by extension) |
| `agent_stopped` | Agent finishes (auto-published by extension) |
| `task_started` | Agent picks up a specific task |
| `task_completed` | Task finished successfully |
| `task_failed` | Task failed (include error in detail) |
| `blocker_found` | Agent hit a blocker (add board note too) |
| `question` | Agent needs human/coordinator input |
| `finding` | Agent discovered something noteworthy |
| `file_changed` | Significant file modification |
| `cost_update` | Token/cost usage update |
| `custom` | Anything else |

### Board Notes
- **`finding`**: Code insights, patterns discovered, things to know
- **`blocker`**: Something preventing progress — always needs attention
- **`question`**: Needs coordinator or human answer
- **`update`**: Status update or progress checkpoint

## Pitfalls

### Never put the infra VM in the swarm pool
`vers_swarm_teardown` destroys ALL VMs that were created by `vers_swarm_spawn`. If you spawned the infra VM (running agent-services) through the swarm, teardown kills your coordination layer. **Always create the infra VM separately** via `vers_vm_create` or `vers_vm_restore` — never through `vers_swarm_spawn`.

### Infra VM setup is a direct operation
Since the infra VM can't be in the swarm, it's fine to set it up directly via `vers_vm_use`. This is the one exception to the "never work on VMs directly" rule — you can't delegate infra setup to an agent that depends on the infra you're setting up.

### Golden images go stale
Application code baked into golden images drifts from main after merges. After merging changes (especially security patches), either rebuild the golden image or patch in place on restored VMs. Keep golden images minimal — base tooling (node, pi, git) only, not application code that changes frequently.

### Swarm agents may ignore inline source in task prompts
When sending large source files inline in a task prompt, agents on golden images may find existing (stale) code at the expected paths and use that instead of writing what you provided. Be explicit: "delete the existing directory first" or verify the deployed code matches after the agent finishes.

### All VM ports are public — always use auth
Vers VMs have no firewall. Every port is reachable at `https://{vmId}.vm.vers.sh:{port}`. Always start agent-services with `VERS_AUTH_TOKEN` set, and pass the same token to all worker VMs via environment variable.

### Web UI for monitoring
The infra VM serves a dashboard at `/ui/` with a 3-panel view of board, feed (live SSE), and registry. Use `POST /auth/magic-link` to generate a browser-accessible auth link. Useful for human operators monitoring the swarm.

## Example: Full Coordinated Build

```
# 1. Check environment
registry_list {}
board_list_tasks {}

# 2. Plan work
board_create_task { title: "Build auth service", tags: ["feature", "auth"], createdBy: "coordinator" }
board_create_task { title: "Build API routes", tags: ["feature", "api"], createdBy: "coordinator" }
board_create_task { title: "Write integration tests", tags: ["test"], createdBy: "coordinator" }

# 3. Spawn agents
vers_swarm_spawn { commitId: "abc123", count: 3, labels: ["auth", "api", "tests"], anthropicApiKey: "sk-..." }

# 4. Verify agents self-registered (automatic via extension)
registry_list { status: "running", role: "worker" }  # Should show 3 agents

# 5. Assign and dispatch
board_update_task { id: "task-1", status: "in_progress", assignee: "worker-auth" }
vers_swarm_task { agentId: "auth", task: "Build the auth service. Task ID: task-1. Use feed_publish for updates." }
# ... repeat for other agents

# 6. Monitor
feed_list { limit: 20 }
board_list_tasks { status: "blocked" }

# 7. Collect
vers_swarm_wait { timeoutSeconds: 600 }

# 8. Wrap up
board_update_task { id: "task-1", status: "done" }
board_update_task { id: "task-2", status: "done" }
board_update_task { id: "task-3", status: "done" }
vers_swarm_teardown {}
```
