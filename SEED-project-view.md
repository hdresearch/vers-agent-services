# SEED: Project View

**Seed ID:** `project-view`  
**Version:** 0.1.0  
**Status:** Draft  
**Author:** Euclid (round 6)  
**Date:** 2026-02-16  

## Summary

A unified project view that aggregates data from all fleet services into a single API call. When someone asks "where are we with X?" — one endpoint answers it.

## Problem

Fleet work spans multiple services: board (tasks), feed (events), reports (documents), registry (agents), log (operations), git (code). Understanding the state of a project requires pulling from 5+ sources and correlating data manually. Orchestrators (like Puck) do this ad-hoc every time.

## Solution

### Data Model: Project

A **Project** is a named initiative with **matchers** — rules that connect it to data across all fleet services.

```typescript
interface Project {
  id: string;
  name: string;                    // "oil-camp", "fleet-seeds"
  displayName: string;             // "Oil Camp", "Fleet Seeds"
  description: string;
  status: "active" | "paused" | "complete" | "abandoned";
  tags: string[];
  matchers: ProjectMatchers;
  createdAt: string;
  updatedAt: string;
}

interface ProjectMatchers {
  boardTags: string[];           // board tasks with these tags
  boardTitlePatterns: string[];  // regex patterns for task titles
  reportTags: string[];          // reports with these tags
  reportAuthors: string[];       // reports by these agents
  feedPatterns: string[];        // feed events matching these
  logPatterns: string[];         // log entries matching these
  gitBranches: string[];         // branch name patterns
  agents: string[];              // agent names associated
  repos: string[];               // git repos
}
```

The matcher pattern is **generic** — any fleet can define their own matchers for their own services. The key insight: projects don't _own_ data in other services. They _find_ it by pattern matching.

### API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects` | Create a project |
| `GET` | `/projects` | List all projects (with filters) |
| `GET` | `/projects/:id` | Get project detail (supports name lookup) |
| `PATCH` | `/projects/:id` | Update project fields |
| `DELETE` | `/projects/:id` | Remove a project |
| `GET` | `/projects/:id/view` | **Unified project view** |

### The Unified View

`GET /projects/:id/view` aggregates across ALL fleet services in parallel:

```json
{
  "project": { "name": "oil-camp", "status": "active", ... },
  "board": {
    "total": 9, "open": 2, "done": 7,
    "tasks": [{ "id": "...", "title": "...", "status": "done" }]
  },
  "reports": [
    { "id": "...", "title": "Oil Camp Round 4", "author": "rustacean-r4" }
  ],
  "agents": [
    { "name": "rustacean", "status": "registered", "lastSeen": "..." }
  ],
  "feed": {
    "recentEvents": [...],
    "totalEvents": 42
  },
  "log": {
    "recentEntries": [...],
    "totalEntries": 15
  },
  "timeline": [
    { "date": "2026-02-14", "event": "Phase 1 complete", "agent": "rustacean", "source": "board" },
    { "date": "2026-02-15", "event": "119 tests passing", "agent": "rustacean-r4", "source": "feed" }
  ],
  "health": {
    "completionRate": 0.78,
    "activeAgents": 0,
    "lastActivity": "2026-02-16T...",
    "blockers": []
  }
}
```

### Architecture

```
┌──────────────────────────────────────────────┐
│                  /projects/:id/view          │
│                  ProjectAggregator           │
├──────────────────────────────────────────────┤
│  ┌──────┐ ┌──────┐ ┌────────┐ ┌──────────┐  │
│  │Board │ │Feed  │ │Reports │ │Registry  │  │
│  │API   │ │API   │ │API     │ │API       │  │
│  └──┬───┘ └──┬───┘ └───┬────┘ └────┬─────┘  │
│     │        │         │           │         │
│  matchers  matchers  matchers   matchers     │
│  (tags,    (agents,  (tags,     (agents)     │
│   regex)    text)     authors)               │
└──────────────────────────────────────────────┘
```

The aggregator calls each service's existing API with the project's matchers, filters results, and assembles the unified view. All queries run in parallel.

## Design Decisions

1. **SQLite store** — Projects are metadata (small, structured). SQLite gives us ACID, indexing, and the JSON1 extension for tag queries.

2. **HTTP-based aggregation** — The aggregator calls fleet APIs over HTTP, not direct store imports. This works in both monolith and microservice mode, and means any fleet service is automatically included if the matchers support it.

3. **Matcher pattern** — Instead of foreign keys or explicit linking, projects _discover_ their data via tag/pattern matching. This is loosely coupled — you can create a project for work that already happened and it will retroactively find all related data.

4. **Name-based lookup** — `GET /projects/oil-camp` works just like `GET /projects/<ulid>`. Convenient for humans and scripts.

5. **Pre-seeded projects** — The five active fleet initiatives come pre-loaded so the system is useful immediately.

## Adopting This Seed

Any fleet running agent-services can:

1. Add the `src/projects/` module
2. Define projects with matchers that match their service naming conventions
3. Call `GET /projects/:name/view` from their orchestrator for instant project status

The matcher pattern is extensible — add new matcher fields for new services without changing the core model.

## Files

```
src/projects/
├── store.ts           # SQLite-backed CRUD with validation
├── aggregator.ts      # Parallel service aggregation + timeline/health
├── routes.ts          # Hono API routes
├── manifest.ts        # Service manifest for ServiceLoader
├── seeds.ts           # Pre-seeded fleet projects
└── __tests__/
    ├── store.test.ts       # 17 tests
    ├── routes.test.ts      # 10 tests
    └── aggregator.test.ts  # 5 tests (mocked HTTP)
```

## Future Work

- **Git integration** — Query Gitea API for branch/commit data using `matchers.repos` and `matchers.gitBranches`
- **Dashboard UI tab** — Render project views in the web UI with progress bars and timelines
- **Project auto-discovery** — Scan board tags and feed agents to suggest new projects
- **Cross-fleet projects** — Projects that span multiple fleets (via ACCP/Thorium Bridge)
- **Project templates** — "Start a new Rust engine project" with pre-configured matchers
