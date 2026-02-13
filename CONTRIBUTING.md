# Contributing to vers-agent-services

## Dev Setup

```bash
git clone https://github.com/hdresearch/vers-agent-services.git
cd vers-agent-services
npm install
```

### Running Locally

```bash
# Development mode (auto-reload on changes)
npm run dev

# Production mode
npm run build
VERS_AUTH_TOKEN=dev-token node dist/server.js
```

### Running Tests

```bash
# Run all tests
npm test

# Watch mode (re-runs on changes)
npm run test:watch

# Run a specific test file
npx vitest run src/board/__tests__/board.test.ts
```

### Building

```bash
npm run build    # TypeScript compile → dist/
```

Build must pass cleanly before committing. No `any` type workarounds — fix the types.

## Git Hooks

This repo uses a **pre-push hook** (`.githooks/pre-push`) that blocks direct pushes to `main`. All changes should go through a PR.

- The hook is activated automatically via the `prepare` script when you run `npm install`.
- To bypass in an emergency: `git push --no-verify`

## Branch and PR Conventions

1. Branch from `main`: `feat/my-feature`, `fix/the-bug`, `docs/the-thing`
2. Keep commits focused — one logical change per commit
3. Commit messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:` prefixes
4. Do not mention private repo names in commit messages
5. Push the branch, open a PR against `main`
6. PRs need: passing build, passing tests, description of what changed

## Project Structure

```
src/
  server.ts              # Main Hono app — mounts all routes
  auth.ts                # Bearer token auth middleware
  board/                 # Task board service
    routes.ts
    store.ts
    __tests__/board.test.ts
  feed/                  # Activity feed service
  log/                   # Append-only log service
  registry/              # VM registry service
  commits/               # Commit ledger service
  reports/               # Reports + sharing service
  skills/                # SkillHub service
  usage/                 # Usage tracking service
  ui/                    # Dashboard UI
skills/                  # Agent skill docs (SKILL.md files)
extensions/              # Pi extension (agent-services.ts)
```

Each service follows the same pattern:
- **`routes.ts`** — Hono route handlers, exports a router
- **`store.ts`** — Persistence layer (JSONL, JSON, or in-memory), exports a class
- **`__tests__/*.test.ts`** — Vitest tests (store unit tests + HTTP route integration tests)

## Definition of Done — New Services

A service is not complete until all applicable items are checked:

- [ ] **Routes** — Hono router in `src/{service}/routes.ts`, mounted in `src/server.ts`
- [ ] **Store** — Persistence layer in `src/{service}/store.ts` (JSONL for append-heavy, JSON for small state, DuckDB/SQLite for query-heavy)
- [ ] **Tests** — Both store unit tests and HTTP route integration tests in `src/{service}/__tests__/`. `npm test` passes with no regressions.
- [ ] **Skill** — Usage documentation at `skills/{service}/SKILL.md` (frontmatter with name/description, when to use, API reference with curl examples, common patterns, schema)
- [ ] **Extension tools** — Pi tools added to `extensions/agent-services.ts` so agents can use the service without raw HTTP calls
- [ ] **UI widget** — Dashboard tab or section in `src/ui/` if the service has data worth visualizing (not always applicable)
- [ ] **Auth** — Bearer auth middleware applied in `server.ts`: `app.use("/{service}/*", bearerAuth())`
- [ ] **Deployed** — Deployed to the infra VM and smoke-tested (see `skills/deploy/SKILL.md`)

### Service Pattern Checklist

When building a new service, follow these patterns from existing services:

**Store:**
- Export custom error classes (`ValidationError`, `NotFoundError`, `ConflictError`)
- Validate all inputs — never trust the caller
- Auto-create data directories on first write
- Provide a `clear()` method for tests
- Use `ulid()` for generated IDs (sorted, unique)

**Routes:**
- Return `201` for creation, `200` for reads/updates/deletes
- Return `400` for validation errors, `404` for not found, `409` for conflicts
- Catch store errors and map to HTTP status codes
- Export the store instance alongside routes (for test access)

**Tests:**
- Use `mkdtempSync` for isolated store tests (no shared state)
- Clean up with `rmSync` in `afterEach`
- Test both happy path and error cases
- For HTTP tests, create a standalone `Hono` app — don't import `server.ts`
- Call `store.clear()` in `beforeEach` for route tests

**Skill:**
- Frontmatter: `name` and `description` (matched by pi's skill discovery)
- Sections: When to Use, Convention (`VERS_INFRA_URL`), API Reference, Common Patterns, Schema
- Include real `curl` examples that work against the running server
- Document tagging/naming conventions if applicable

## Adding Extension Tools

Extension tools live in `extensions/agent-services.ts`. Each tool needs:

```typescript
{
  name: "service_action",        // e.g., "board_create_task"
  description: "...",
  parameters: { /* JSON Schema */ },
  execute: async (params) => {
    const result = await api("POST", "/service/endpoint", params);
    return JSON.stringify(result, null, 2);
  },
}
```

Conventions:
- Tool names: `{service}_{action}` (snake_case)
- Use the shared `api()` helper for HTTP calls
- Return JSON stringified results
- Handle errors gracefully — return error messages, don't throw

## Existing Skills

Skills teach agents how to use services. They live in `skills/{name}/SKILL.md` and are auto-discovered by pi.

| Skill | Description |
|-------|-------------|
| `board` | Task board — creating, assigning, tracking tasks |
| `commits` | Commit ledger — recording and querying VM snapshots |
| `deploy` | Deploy runbook — deploying to the infra VM |
| `feed` | Activity feed — publishing and subscribing to events |
| `registry` | VM registry — service discovery and heartbeats |
| `reports` | Reports — generating and sharing session reports |

## Common Development Tasks

### Add a new route to an existing service

1. Add the handler in `src/{service}/routes.ts`
2. Add store method if needed in `src/{service}/store.ts`
3. Add tests in `src/{service}/__tests__/`
4. `npm run build && npm test`
5. Update the skill if the API surface changed

### Add a new service from scratch

1. Create `src/{service}/store.ts` — persistence + validation
2. Create `src/{service}/routes.ts` — Hono router
3. Mount in `src/server.ts` — import, add auth middleware, add route
4. Create `src/{service}/__tests__/{service}.test.ts`
5. `npm run build && npm test`
6. Create `skills/{service}/SKILL.md`
7. Add tools to `extensions/agent-services.ts`
8. Deploy to infra (see `skills/deploy/SKILL.md`)
