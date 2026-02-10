---
name: recovery
description: Recover orchestrator state after a session restart. Use at the start of any new session to discover running agents, pending tasks, and recent activity.
---

# Session Recovery Protocol

When starting a new orchestrator session (after restart, `/reload`, or fresh start), follow this protocol to recover state before doing anything else.

## Prerequisites

- `VERS_INFRA_URL` and `VERS_AUTH_TOKEN` must be set
- The agent-services extension must be loaded

## Steps

### 1. Check infrastructure health

```
registry_discover { role: "infra" }
```

If no infra VM found, the coordination layer is down — you'll need to restore or recreate it before proceeding.

### 2. Read the board

```
board_list_tasks {}
```

Categorize tasks by status: `open`, `in_progress`, `blocked`, `done`. This is your source of truth for what work exists.

### 3. Read recent activity

```
feed_list { limit: 50 }
```

Scan for recent `agent_started`, `agent_stopped`, `blocker_found`, `task_completed` events to understand what happened since last session.

### 4. Discover running agents

```
registry_list { status: "running" }
```

Cross-reference with `in_progress` board tasks to see which agents are still alive and working.

If using swarm tools:
```
vers_swarm_status {}
```

### 5. Resume coordination

- **`in_progress` tasks**: Check if the assigned agent is still running (in registry). If not, reassign or spawn a new agent.
- **`blocked` tasks**: Read the blocker notes, resolve, and reassign.
- **`open` tasks**: Assign to available agents or spawn new ones.
- **`done` tasks**: Review results, merge PRs, close out.
- **Stale registry entries**: VMs with no heartbeat in 5+ min are likely dead. Clean up or re-spawn.

### 6. Publish recovery event

```
feed_publish {
  agent: "orchestrator",
  type: "custom",
  summary: "Orchestrator recovered — N agents running, M tasks in progress"
}
```

## What Happens Automatically

The agent-services extension handles these on every agent boot — no manual action needed:

- Publishes `agent_started` / `agent_stopped` to the feed
- Registers the agent in the registry (using `VERS_VM_ID`)
- Sends heartbeats every 60s to keep the registration alive
- Updates registry status to `stopped` on shutdown

You only need to manually register VMs that were created outside the extension (e.g., infra VMs set up via `vers_vm_use`).

Additionally, the extension syncs skills from the SkillHub (`/skills/*`) to `~/.pi/agent/skills/_hub/` on session start and subscribes to SSE for live updates — so recovered agents automatically get the latest skill definitions.
