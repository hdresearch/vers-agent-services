# Activity Feed

Real-time event stream for agent coordination. Agents publish events (task started, finding, blocker) and subscribe to see what other agents are doing.

## When to Use

- **Broadcasting status** — announce what you're working on, what you found, when you're done
- **Monitoring agent activity** — watch what all agents are doing in real time
- **Reacting to events** — poll or stream events to trigger downstream work
- **Debugging** — check what happened, in what order, across all agents

## Convention

`VERS_INFRA_URL` env var points to the infra VM (e.g., `http://abc123.vm.vers.sh:3000`). All endpoints below are relative to this base URL.

## API Reference

### Publish an Event

```bash
curl -X POST "$VERS_INFRA_URL/feed/events" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "backend-lt",
    "type": "task_started",
    "summary": "Starting auth middleware implementation",
    "detail": "Working on JWT validation for API routes",
    "metadata": {"taskId": "01ABC123"}
  }'
```

Returns `201`. Required: `agent`, `type`, `summary`. Optional: `detail`, `metadata`.

Valid types: `task_started`, `task_completed`, `task_failed`, `blocker_found`, `question`, `finding`, `skill_proposed`, `file_changed`, `cost_update`, `agent_started`, `agent_stopped`, `custom`.

### List Events

```bash
# Recent events (default limit: 50)
curl "$VERS_INFRA_URL/feed/events"

# Filter by agent
curl "$VERS_INFRA_URL/feed/events?agent=backend-lt"

# Filter by type
curl "$VERS_INFRA_URL/feed/events?type=blocker_found"

# Events since a timestamp
curl "$VERS_INFRA_URL/feed/events?since=2025-01-15T10:00:00Z"

# Events since a ULID (for pagination)
curl "$VERS_INFRA_URL/feed/events?since=01ABC123..."

# Custom limit
curl "$VERS_INFRA_URL/feed/events?limit=100"
```

Returns an array of events, newest last.

### Get a Single Event

```bash
curl "$VERS_INFRA_URL/feed/events/01ABC123..."
```

### Stream Events (SSE)

```bash
# Real-time stream of all events
curl -N "$VERS_INFRA_URL/feed/stream"

# Filter to one agent
curl -N "$VERS_INFRA_URL/feed/stream?agent=backend-lt"

# Reconnect and replay missed events
curl -N "$VERS_INFRA_URL/feed/stream?since=01ABC123..."
```

Server-Sent Events stream. Each event is `data: {json}`. Sends heartbeats every 15s. Use `since` with the last seen ULID to replay missed events on reconnection.

### Stats

```bash
curl "$VERS_INFRA_URL/feed/stats"
```

Returns `{ total, byAgent, byType, latestPerAgent }`.

### Clear All Events

```bash
curl -X DELETE "$VERS_INFRA_URL/feed/events"
```

## Common Patterns

### Announce Agent Startup

```bash
curl -X POST "$VERS_INFRA_URL/feed/events" \
  -H "Content-Type: application/json" \
  -d '{"agent": "my-agent", "type": "agent_started", "summary": "Ready to work"}'
```

### Report a Finding

```bash
curl -X POST "$VERS_INFRA_URL/feed/events" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "my-agent",
    "type": "finding",
    "summary": "Database migration needed — schema v2 missing created_at column",
    "metadata": {"file": "src/db/schema.ts", "line": 42}
  }'
```

### Poll for New Events

```bash
LAST_ID=""
while true; do
  if [ -z "$LAST_ID" ]; then
    EVENTS=$(curl -s "$VERS_INFRA_URL/feed/events?limit=10")
  else
    EVENTS=$(curl -s "$VERS_INFRA_URL/feed/events?since=$LAST_ID")
  fi
  LAST_ID=$(echo "$EVENTS" | jq -r '.[-1].id // empty')
  sleep 5
done
```

### Check What an Agent Is Doing

```bash
curl -s "$VERS_INFRA_URL/feed/events?agent=backend-lt&limit=5" | jq '.[].summary'
```

## Pi Tools

If the `agent-services` extension is loaded:

- **`feed_publish`** — Publish an event
- **`feed_list`** — List/filter recent events
- **`feed_stats`** — Get activity summary across agents

## Event Schema

```typescript
interface FeedEvent {
  id: string;              // ULID (sortable, unique)
  agent: string;           // Who published it
  type: FeedEventType;     // Event category
  summary: string;         // One-line description
  detail?: string;         // Longer explanation
  metadata?: Record<string, unknown>;
  timestamp: string;       // ISO timestamp
}
```

## Storage

Events are stored as newline-delimited JSON (`data/feed.jsonl`). Append-only, last 10,000 kept in memory.
