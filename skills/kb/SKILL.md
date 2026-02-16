---
name: kb
description: Fleet knowledge base for persistent lessons, conventions, SOPs, gotchas, decisions, and references. Use when learning something the fleet should know, before starting unfamiliar work, or when the orchestrator tasks you to add knowledge.
---

# Fleet Knowledge Base (KB)

Persistent knowledge store that survives across sessions, agents, and context windows. Every agent gets the KB briefing automatically on boot — no manual action needed.

## When to Use

- **Before starting work**: Search the KB for existing knowledge about the domain (`kb_search`)
- **After learning something**: Add it to the KB so no agent repeats the mistake (`kb_add`)
- **When hitting a gotcha**: Record it immediately — these are the most valuable entries
- **During reaping**: Extract lessons from completed/failed agents before destroying their VMs
- **Reviewing fleet state**: Check what the fleet knows (`kb_briefing`, `kb_stats`)

## How It Works

### Automatic Distribution

On every agent session start, the agent-services extension:
1. Fetches the full KB briefing from `/kb/briefing`
2. Writes it to `~/.pi/agent/context/kb-briefing.md`
3. Pi automatically includes context files in the system prompt

**Result**: Every spawned agent inherits all fleet knowledge without any manual steps.

### Entry Types

| Type | Use for |
|------|---------|
| `lesson` | Things learned the hard way — failures, surprises, corrections |
| `convention` | Team/fleet agreements on how to do things |
| `sop` | Standard Operating Procedures — step-by-step workflows |
| `gotcha` | Things that trip agents up — traps, edge cases, footguns |
| `reference` | Links, API docs, architecture notes |
| `decision` | Architecture or process decisions with rationale |

### Priority Levels

| Priority | Behavior |
|----------|----------|
| `critical` | Always shown first in briefings, never filtered out |
| `high` | Shown prominently |
| `normal` | Default — included in briefings |
| `low` | Included but shown last |

### Decay

Entries can have a `decayDays` value. After that many days, the entry expires and is excluded from briefings and searches (unless `includeExpired=true`). Use for:
- Temporary workarounds
- Time-sensitive knowledge
- Entries that will be superseded

Omit `decayDays` for permanent knowledge.

## Tools

### `kb_add` — Add knowledge

```
kb_add {
  type: "gotcha",
  title: "fuser not installed on infra VMs",
  content: "Don't use fuser to find processes by port. Use `ss -tlnp | grep PORT | grep -oP 'pid=\\K\\d+'` instead.",
  tags: ["infra", "ops"],
  priority: "high",
  source: "agent:ops-lt"
}
```

### `kb_search` — Find knowledge

```
kb_search { search: "IPv6" }
kb_search { type: "gotcha", tag: "deploy" }
kb_search { priority: "critical" }
```

### `kb_briefing` — Full briefing document

```
kb_briefing {}
kb_briefing { tags: ["deploy", "infra"] }
```

### `kb_stats` — Knowledge base statistics

```
kb_stats {}
```

## API Reference

All endpoints require `Authorization: Bearer $VERS_AUTH_TOKEN`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/kb/entries` | Create entry |
| `GET` | `/kb/entries` | List/search (query params: `type`, `tag`, `priority`, `source`, `search`, `includeExpired`) |
| `GET` | `/kb/entries/:id` | Get single entry (increments access count) |
| `PATCH` | `/kb/entries/:id` | Update entry |
| `DELETE` | `/kb/entries/:id` | Delete entry |
| `GET` | `/kb/briefing` | Compiled markdown briefing (query params: `tags`, `maxEntries`, `format=text`) |
| `GET` | `/kb/stats` | Statistics |

## Conventions

### Who adds entries

- **Orchestrator**: Adds entries from reap summaries, cross-agent patterns, user corrections
- **Lieutenants/Workers**: Add entries when they discover gotchas or learn something domain-specific
- **Human**: Adds conventions and decisions through the orchestrator or API

### Source format

Use `agent:NAME` for agent-sourced entries, `human:NAME` for human-sourced, `system` for auto-generated.

### Tagging

Use consistent tags across the fleet:
- Domain: `deploy`, `auth`, `api`, `ui`, `infra`, `networking`
- Scope: `vers`, `agent-services`, `pi`, `golden-image`
- Type hint: `workaround`, `permanent`, `temporary`

### When to update vs create new

- **Update**: If the existing entry is still about the same thing but needs correction
- **Create new**: If it's a different lesson/gotcha even in the same domain
- **Delete**: If the entry is no longer true (workaround for a fixed bug, etc.)
