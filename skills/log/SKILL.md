---
name: log
description: Append-only work log for agent sessions. Use when recording what happened, what was decided, and what's next — the log is for the next session's orchestrator.
---

# Work Log

Carmack `.plan`-style append-only log. Every agent writes what they're doing as they do it. The log is the narrative record of a session — when a new orchestrator session starts, the first thing it reads is the log to understand what happened while it was gone.

## When to Use

- **Session starts** — log that you're online and what you plan to work on
- **LT dispatched** — log which lieutenant was assigned which task
- **Results arrive** — log what a lieutenant produced (branch name, test results, key decisions)
- **Decisions made** — log why you chose approach A over B
- **Problems hit** — log what went wrong and how you resolved it (or didn't)
- **Session ends** — log a summary of what was accomplished and what's pending

## The Key Rule

**Write as things happen, not in batches.** If you find yourself batching 3+ entries at once, you waited too long. The log should read like a timeline, not a retrospective.

Good: entry after each event as it happens.
Bad: one giant entry at the end summarizing everything.

## Who Is This For?

The log is for the **next session's orchestrator**. Assume the reader:

- Has no memory of this session
- Needs to pick up exactly where you left off
- Wants to know what happened, in what order, and why
- Doesn't want to dig through board tasks and feed events to reconstruct the timeline

The board tracks *tasks*. The feed tracks *events*. The log tracks the *narrative* — the human-readable story of what happened.

## Convention

`VERS_INFRA_URL` env var points to the infra VM (e.g., `http://abc123.vm.vers.sh:3000`). All endpoints require `Authorization: Bearer $VERS_AUTH_TOKEN`.

## API Reference

### Append a Log Entry

```bash
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Session started. 3 open tasks on the board — share links, usage tracking, commit ledger.",
    "agent": "orchestrator"
  }'
```

Returns `201`. Required: `text`. Optional: `agent`.

Each entry gets a ULID `id` and ISO `timestamp` automatically.

### Query Log Entries (JSON)

```bash
# Last 24 hours (default if no time range given)
curl "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Last N hours or days
curl "$VERS_INFRA_URL/log?last=8h" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

curl "$VERS_INFRA_URL/log?last=7d" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Since a specific timestamp
curl "$VERS_INFRA_URL/log?since=2026-02-10T15:00:00Z" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Time range
curl "$VERS_INFRA_URL/log?since=2026-02-10T09:00:00Z&until=2026-02-10T17:00:00Z" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Returns `{ entries: [...], count: N }`. Entries are in chronological order (oldest first).

### Query Log Entries (Plain Text)

```bash
curl "$VERS_INFRA_URL/log/raw?last=24h" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Returns plain text, one line per entry:

```
[2026-02-10T15:30:00Z] (orchestrator) Session started. 3 open tasks on the board.
[2026-02-10T15:31:12Z] (orchestrator) Dispatched lt-share-links to work on share link feature.
[2026-02-10T16:45:03Z] (orchestrator) lt-share-links completed — branch feat/report-share-links, 24 tests, PR #16.
```

The `/raw` endpoint is ideal for piping into a model's context at session start.

## Common Patterns

### Orchestrator Session Startup

```bash
# Read what happened recently
curl -s "$VERS_INFRA_URL/log/raw?last=24h" -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Log that you're here
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "New session started. Reading board and recent log to recover context.", "agent": "orchestrator"}'
```

### Dispatching Work

```bash
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Dispatched lt-share-links to build report share links. Task 01KH5V32...", "agent": "orchestrator"}'
```

### Recording Results

```bash
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "lt-share-links done. Branch feat/report-share-links pushed, 24 tests passing, PR #16 opened. Found issue: better-sqlite3 dep missing from package.json after merge.", "agent": "orchestrator"}'
```

### Recording Decisions

```bash
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Decision: using SQLite for share links instead of JSONL. Need row-level revocation and access count queries — JSONL cant do that without full scans.", "agent": "orchestrator"}'
```

### Recording Problems

```bash
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Deploy failed — better-sqlite3 missing from package.json on main. Got dropped during merge of PR #17. Fixed manually on infra VM, need to push fix to main.", "agent": "orchestrator"}'
```

### Session End Summary

```bash
curl -X POST "$VERS_INFRA_URL/log" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Session ending. Completed: share links (PR #16 merged), usage tracking (PR #17 merged), commit ledger (PR #18 merged). Deployed all to infra. Remaining: deploy snapshot before next code deploy. 310 tests passing.", "agent": "orchestrator"}'
```

## Pi Tools

If the `agent-services` extension is loaded:

- **`log_append`** — Append a log entry
- **`log_query`** — Query entries with time filters

## Log Entry Schema

```typescript
interface LogEntry {
  id: string;          // ULID (sortable, unique)
  timestamp: string;   // ISO timestamp (auto-generated)
  text: string;        // The log message
  agent?: string;      // Who wrote it
}
```

## Storage

Entries are stored as newline-delimited JSON (`data/log.jsonl`). Append-only — entries are never modified or deleted.
