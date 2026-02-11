---
name: board
description: Shared task board for coordinating work across agents. Use when creating, assigning, tracking, or querying tasks in a swarm.
---

# Task Board

Shared task board for coordinating work across agents. Agents create tasks, claim them, post notes with findings, and mark them done.

## When to Use

- **Orchestrating multi-agent work** — break work into tasks, assign to agents
- **Tracking blockers** — agents post blocker notes so others can help
- **Sharing findings** — post notes on tasks with discoveries, questions, updates
- **Checking what's in progress** — list tasks by status or assignee

## Convention

`VERS_INFRA_URL` env var points to the infra VM (e.g., `http://abc123.vm.vers.sh:3000`). All endpoints below are relative to this base URL.

## API Reference

### Create a Task

```bash
curl -X POST "$VERS_INFRA_URL/board/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement auth middleware",
    "description": "Add JWT validation to all API routes",
    "createdBy": "orchestrator",
    "assignee": "backend-lt",
    "tags": ["auth", "backend"],
    "dependencies": []
  }'
```

Returns `201`. Required: `title`, `createdBy`. Optional: `description`, `status` (default: `open`), `assignee`, `tags`, `dependencies`.

### List Tasks

```bash
# All tasks
curl "$VERS_INFRA_URL/board/tasks"

# Filter by status
curl "$VERS_INFRA_URL/board/tasks?status=in_progress"

# Filter by assignee
curl "$VERS_INFRA_URL/board/tasks?assignee=backend-lt"

# Filter by tag
curl "$VERS_INFRA_URL/board/tasks?tag=auth"
```

Returns `{ tasks: [...], count: N }`. Sorted newest first. Valid statuses: `open`, `in_progress`, `blocked`, `done`.

### Get a Task

```bash
curl "$VERS_INFRA_URL/board/tasks/01ABC123..."
```

### Update a Task

```bash
curl -X PATCH "$VERS_INFRA_URL/board/tasks/01ABC123..." \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress", "assignee": "backend-lt"}'
```

Updatable: `title`, `description`, `status`, `assignee` (set `null` to unassign), `tags`, `dependencies`.

### Delete a Task

```bash
curl -X DELETE "$VERS_INFRA_URL/board/tasks/01ABC123..."
```

### Add a Note

```bash
curl -X POST "$VERS_INFRA_URL/board/tasks/01ABC123.../notes" \
  -H "Content-Type: application/json" \
  -d '{
    "author": "backend-lt",
    "content": "Found the root cause — missing CORS header in preflight",
    "type": "finding"
  }'
```

Returns `201`. Required: `author`, `content`, `type`. Valid types: `finding`, `blocker`, `question`, `update`.

### Get Notes

```bash
curl "$VERS_INFRA_URL/board/tasks/01ABC123.../notes"
```

Returns `{ notes: [...], count: N }`.

## Common Patterns

### Agent Claims a Task

```bash
# List open tasks assigned to me (or unassigned)
curl "$VERS_INFRA_URL/board/tasks?status=open&assignee=my-agent"

# Claim and start
curl -X PATCH "$VERS_INFRA_URL/board/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress", "assignee": "my-agent"}'
```

### Report a Blocker

```bash
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Content-Type: application/json" \
  -d '{"author": "my-agent", "content": "Cannot proceed — DB credentials missing from env", "type": "blocker"}'

curl -X PATCH "$VERS_INFRA_URL/board/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked"}'
```

### Complete a Task

```bash
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Content-Type: application/json" \
  -d '{"author": "my-agent", "content": "Auth middleware implemented and tested", "type": "update"}'

curl -X PATCH "$VERS_INFRA_URL/board/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

## Board Update Protocol for LTs

Lieutenants follow a strict protocol for board updates. The board is the source of truth — if the board is stale, the orchestrator can't coordinate.

### On task assignment

Set status to `in_progress` and assign yourself immediately. Don't start work silently.

```bash
curl -X PATCH "$VERS_INFRA_URL/board/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress", "assignee": "my-lt-name"}'
```

### While working

Add notes as things happen — findings, decisions, blockers. Don't batch them.

```bash
# Found something relevant
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Content-Type: application/json" \
  -d '{"author": "my-lt-name", "content": "Auth tokens expire after 1h, not 24h as documented", "type": "finding"}'

# Made a design decision
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Content-Type: application/json" \
  -d '{"author": "my-lt-name", "content": "Using SQLite instead of JSONL — need row-level revocation", "type": "update"}'
```

### When blocked

Set status to `blocked` with a note explaining what's wrong and what you need.

```bash
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Content-Type: application/json" \
  -d '{"author": "my-lt-name", "content": "Cannot SSH to infra VM — no key access. Need orchestrator to deploy.", "type": "blocker"}'

curl -X PATCH "$VERS_INFRA_URL/board/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked"}'
```

### When done

Set status to `in_review` and add a summary note with: what changed, branch name, test results.

```bash
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Content-Type: application/json" \
  -d '{"author": "my-lt-name", "content": "Branch feat/share-links pushed. 24 new tests, all passing. Added SQLite store, admin routes, public viewer route.", "type": "update"}'

curl -X PATCH "$VERS_INFRA_URL/board/tasks/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_review"}'
```

The orchestrator moves tasks from `in_review` to `done` after verification. LTs don't mark their own tasks `done`.

## Self-Management

**Orchestrators are responsible for keeping the board current.** Don't wait to be asked. The board is the persistence layer — a new session reads it to understand what's happening. If it's stale, recovery fails.

- Create tasks as work is identified (even from casual conversation)
- Update status immediately when work starts, finishes, or gets blocked
- Add notes with findings, decisions, context as work progresses
- Close tasks when PRs merge or work is verified
- Clean up stale tasks — if an agent is gone, update the task

## Automatic Behavior

The agent-services extension does **not** auto-create board tasks — all task management is manual/explicit. However, agents auto-register in the registry and publish to the feed on startup, so you can discover available agents before assigning tasks.

## Pi Tools

If the `agent-services` extension is loaded:

- **`board_create_task`** — Create a new task
- **`board_list_tasks`** — List/filter tasks
- **`board_update_task`** — Update status, assignee, etc.
- **`board_add_note`** — Post a finding, blocker, question, or update

## Task Schema

```typescript
interface Task {
  id: string;              // ULID
  title: string;
  description?: string;
  status: "open" | "in_progress" | "blocked" | "done";
  assignee?: string;
  tags: string[];
  dependencies: string[];  // Task IDs this depends on
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: Note[];
}

interface Note {
  id: string;
  author: string;
  content: string;
  type: "finding" | "blocker" | "question" | "update";
  createdAt: string;
}
```
