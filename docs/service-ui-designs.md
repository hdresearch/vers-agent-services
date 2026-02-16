# Service UI Designs

Design specifications for all 10 services that needed dashboard tabs.
**Built:** Events, Daemon, Config (top 3 by operational value).
**Designed:** Contacts, Fleet Loop, Personas, Cryochamber, LLM Router, Commits, Gossip.

> Note: Personas, Cryochamber, and Fleet Loop already have functional UIs in the **Agents** tab (`agents.js`). Gossip has a sub-view in the **Comms** tab (`comms.js`). These designs describe improvements and standalone tab options.

---

## ✅ BUILT: Events Tab (`events.js`)

**Priority rationale:** 6,543 events across 17 sources — the most active system. Critical for debugging, audit trails, and understanding fleet behavior.

### Layout
- **Stats bar** (top): Total events + top 8 sources as clickable filter chips
- **Toolbar**: Source/type/agent text filters, limit selector, noise exclusion toggle, stream button
- **Event list** (scrollable): Rows with ID, timestamp, color-coded source, type, agent, age
- **Click to expand**: Shows full JSON payload
- **Type breakdown modal**: Full table of all event types sorted by count, click to filter
- **SSE streaming**: Live event stream with green dot indicator, flash animation on new events

### API Endpoints Used
- `GET /events?source=&type=&agent=&limit=&exclude=`
- `GET /events/stats`
- `GET /events/stream` (SSE)

---

## ✅ BUILT: Daemon Tab (`daemon.js`)

**Priority rationale:** The daemon is the autonomous event processor — knowing its state, cursor position, and action history is essential for ops.

### Layout
- **Left panel (380px)**: Status indicator (running/stopped with pulse), start/stop buttons, 6 vital cards (uptime, started, last poll, last action, event cursor, total actions), recent actions preview
- **Right panel**: Full action log with limit selector, expandable action cards showing trigger, event ID, result detail, and metadata JSON

### API Endpoints Used
- `GET /daemon/status`
- `GET /daemon/actions?limit=`
- `POST /daemon/start`
- `POST /daemon/stop`

---

## ✅ BUILT: Config Tab (`config.js`)

**Priority rationale:** Managing secrets (API keys) and config values from the dashboard avoids SSH. High operational value.

### Layout
- **Stats bar**: Total / secrets / config counts
- **Toolbar**: Key filter, type dropdown, + Add button
- **Entry list**: Cards with left border color (red=secret, green=config), key name, masked value, reveal/edit/delete buttons
- **Reveal**: Fetches full value via `?reveal=true`, auto-hides after 10 seconds
- **Edit modal**: Key/value/type form, handles secret preservation (empty = keep existing)

### API Endpoints Used
- `GET /config` (masked values)
- `GET /config/:key?reveal=true`
- `PUT /config/:key`
- `DELETE /config/:key`

---

## 📐 DESIGN: Contacts / Peering Tab

### Data
- Contacts: `{id, commonName, fleetName, githubUsername, endpoint, publicKey, trustLevel, notes, tags, createdAt}`
- Peering invites: `{id, label, createdAt, expiresAt, redeemed}`

### Layout
```
┌─────────────────────────────────────────────┐
│ Stats: N contacts │ N trusted │ N pending   │
├─────────────────────┬───────────────────────┤
│ Contact List        │ Add / Invite Panel    │
│                     │                       │
│ [card] Noah (GH)   │ ┌─ Add by GitHub ──┐  │
│   trusted │ 2 keys  │ │ username: [____] │  │
│                     │ │ [Fetch & Add]    │  │
│ [card] Barton       │ └──────────────────┘  │
│   pending │ 0 keys  │                       │
│                     │ ┌─ Peering Invite ─┐  │
│                     │ │ [Generate Link]  │  │
│                     │ │ Active invites:  │  │
│                     │ │  - inv-1 (used)  │  │
│                     │ └──────────────────┘  │
└─────────────────────┴───────────────────────┘
```

### Actions
- List contacts with trust level filter
- Add contact by GitHub username (auto-fetches SSH keys)
- Create contact manually (name, endpoint, public key)
- Change trust level (untrusted → pending → trusted)
- Generate peering invite link
- Accept incoming peering invite

### API Endpoints
- `GET /contacts?trustLevel=&search=`
- `POST /contacts` / `POST /contacts/from-github/:username`
- `PATCH /contacts/:id`
- `DELETE /contacts/:id`
- `POST /contacts/peer/invite` / `GET /contacts/peer/invites`
- `POST /contacts/peer/accept`

---

## 📐 DESIGN: Fleet Loop Tab (Enhancement)

Already exists in Agents tab. Proposed improvements:

### Additions
- **Run history timeline**: Show last N runs per role as a mini timeline chart
- **Run detail view**: Click a run to see duration, result, any events emitted
- **Interval editor**: Inline edit interval for each role (currently patch-only)
- **Health sparkline**: Visual indicator of success/failure ratio over last hour

### API Endpoints (additional)
- `GET /loop/runs?role=&limit=`

---

## 📐 DESIGN: Personas Tab (Enhancement)

Already exists in Agents tab. Proposed improvements:

### Additions
- **Version diff view**: Compare two versions of a persona side-by-side
- **Usage tracking**: Show which cryo agents use each persona
- **Import/Export**: JSON import/export for persona sharing
- **Template gallery**: Pre-built persona templates as starting points

### API Endpoints (additional)
- `GET /personas/:name/versions`

---

## 📐 DESIGN: Cryochamber Tab (Enhancement)

Already exists in Agents tab. Proposed improvements:

### Additions
- **Agent timeline**: Visual history of wake/hibernate/retire transitions
- **Session log**: Link to log entries from each agent's sessions
- **Bulk actions**: Select multiple agents for bulk wake/freeze
- **Commit association**: Show and link to commit ledger entries

### API Endpoints (additional)
- `GET /cryo/agents/:name` (full agent with history)

---

## 📐 DESIGN: LLM Router Tab

### Data
- Providers: `{name, baseUrl, apiKeyConfigKey, models[], defaultHeaders}`
- Rate limits per agent: `{agent, requestsPerMinute}`
- Stats: `{totalRequests, totalInputTokens, totalOutputTokens, byAgent{}, byModel{}}`

### Layout
```
┌─────────────────────────────────────────────────────────┐
│ Status: ok/degraded │ Total Requests: N │ Cost: $X.XX   │
├──────────────────┬──────────────────────────────────────┤
│ Providers        │ Stats & Usage                        │
│                  │                                      │
│ ┌─ anthropic ──┐ │ ┌── By Model ─────────────────────┐ │
│ │ models: cl*  │ │ │ claude-*  │████████│ 120 req    │ │
│ │ key: ✓ set   │ │ │ gpt-4*   │███     │  40 req    │ │
│ │ [Edit]       │ │ └────────────────────────────────┘ │
│ └──────────────┘ │                                      │
│                  │ ┌── By Agent ─────────────────────┐ │
│ ┌─ openai ─────┐ │ │ architect  │██████│ $0.42      │ │
│ │ models: gpt* │ │ │ sentinel   │██    │ $0.12      │ │
│ │ key: ✗ miss  │ │ └────────────────────────────────┘ │
│ └──────────────┘ │                                      │
│                  │ Rate Limits                          │
│ [+ Add Provider] │ [agent] [rpm] [Set]                 │
└──────────────────┴──────────────────────────────────────┘
```

### Actions
- View provider list with key status (set vs missing via /v1/health)
- Edit provider config (base URL, models, headers)
- View request stats broken down by model and agent
- Set rate limits per agent
- Cost tracking per agent (derived from token counts)

### API Endpoints
- `GET /v1/health`
- `GET /v1/providers` / `PUT /v1/providers/:name`
- `GET /v1/rate-limits/:agent` / `PUT /v1/rate-limits/:agent`
- `GET /v1/stats?range=1h`

---

## 📐 DESIGN: Commits Tab

### Data
- Commits: `{commitId, vmId, label, agent, tags[], description, parentCommitId, createdAt}`

### Layout
```
┌─────────────────────────────────────────────────┐
│ Total: N commits │ VMs: N │ Agents: N           │
├─────────────────────────────────────────────────┤
│ Filters: [vmId] [agent] [tag] [label] [since]  │
├─────────────────────────────────────────────────┤
│ Timeline (vertical)                              │
│                                                  │
│ ● commit-abc  │ infra-snapshot  │ golden         │
│ │  VM: e0e2bf  │ by: orchestrator │ 2h ago       │
│ │  "Pre-deploy snapshot"                         │
│ │                                                │
│ ● commit-def  │ worker-state    │ checkpoint     │
│ │  VM: a1b2c3  │ by: architect   │ 5h ago        │
│ │  "After KB migration"                          │
│ │                                                │
│ ● commit-ghi  │ golden-v3       │ golden         │
│    VM: 1e97bd  │ by: orchestrator │ 1d ago        │
│    Parent: commit-xyz                            │
└──────────────────────────────────────────────────┘
```

### Actions
- Browse commits with filters (vmId, agent, tag, label, since)
- View commit details (description, parent chain)
- Delete commit entries (cleanup)
- Copy commit ID for use in restore operations

### API Endpoints
- `GET /commits?vmId=&agent=&tag=&label=&since=`
- `GET /commits/:id`
- `DELETE /commits/:id`

---

## 📐 DESIGN: Gossip Tab (Replacement for broken Comms sub-view)

### Data
- Messages: `{id, from, to, type, subject, body, priority, threadId, read, createdAt}`
- Types: request, response, broadcast, notification

### Layout
```
┌─────────────────────────────────────────────────┐
│ Inbox: [agent name ▼] │ Unread: N │ Total: N    │
├───────────────────┬─────────────────────────────┤
│ Message List      │ Thread View / Compose        │
│                   │                              │
│ [msg] from:arch   │ Subject: Deploy review       │
│  ★ request        │ From: architect → sentinel   │
│  "Deploy review"  │                              │
│  2m ago           │ Body: Please review the...   │
│                   │                              │
│ [msg] broadcast   │ ─── Reply ───                │
│  📢 notification  │ From: sentinel → architect   │
│  "KB synced"      │ Looks good, approved.        │
│  15m ago          │                              │
│                   │ ┌── Compose Reply ─────────┐ │
│ ── Read ──        │ │ [text area]              │ │
│ [msg] from:scribe │ │ [Send Reply]             │ │
│                   │ └──────────────────────────┘ │
│                   │                              │
│ [+ New Message]   │ [+ Broadcast]                │
└───────────────────┴─────────────────────────────┘
```

### Actions
- View inbox for any agent
- Read/unread filtering
- View message threads
- Mark messages as read
- Compose new messages (from, to, type, subject, body)
- Broadcast to all agents

### API Endpoints
- `GET /gossip/messages?to=&unread=true&limit=`
- `GET /gossip/threads/:id`
- `POST /gossip/messages/:id/read`
- `POST /gossip/messages`
- `POST /gossip/broadcast`

---

## Implementation Priority

| Rank | Service | Status | Rationale |
|------|---------|--------|-----------|
| 1 | Events | ✅ Built | Most data (6.5K events), critical for debugging |
| 2 | Daemon | ✅ Built | Autonomous processor monitoring, ops essential |
| 3 | Config | ✅ Built | Secret/config management without SSH |
| 4 | LLM Router | 📐 Design | Cost tracking + model management = high value |
| 5 | Commits | 📐 Design | VM snapshot history for recovery |
| 6 | Contacts | 📐 Design | Peering infrastructure for fleet networking |
| 7 | Gossip | 📐 Design | Fix broken comms sub-view |
| 8 | Personas | 📐 Enhancement | Already works, version diff would help |
| 9 | Cryochamber | 📐 Enhancement | Already works, timeline would help |
| 10 | Fleet Loop | 📐 Enhancement | Already works, run history would help |

---

## Technical Pattern

All tabs follow the same architecture:
- **IIFE module** wrapping all state and functions
- **`fapi()`** helper using `/ui/api/` proxy (auto-injects auth)
- **`_tabInit()` / `_tabDestroy()`** lifecycle hooks called by `app.js`
- **30s auto-refresh** via `setInterval`, cleared on tab leave
- **`esc()`** for XSS-safe HTML rendering
- **Click-to-expand** cards for detail views
- **Modal overlays** for forms (reusing `.agents-modal-overlay` CSS)
