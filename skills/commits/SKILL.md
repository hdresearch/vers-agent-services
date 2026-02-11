---
name: commits
description: Commit ledger for tracking VM snapshots. Use when recording, querying, or managing Vers VM commit history — golden images, infra snapshots, rollback points.
---

# Commit Ledger

Tracks VM snapshots (commits) so agents can answer questions like "what was the last golden image?" or "which commit had the working Node.js install?" The Vers API has no "list my commits" endpoint, so this ledger fills that gap.

## When to Use

- **After `vers_vm_commit`** — record the commit so it's discoverable later
- **Building golden images** — tag commits as `golden`, `stable`, `broken`, etc.
- **Before a risky operation** — snapshot first, record it, so you can roll back
- **Finding a previous snapshot** — look up by label, agent, tag, or time range
- **Cleaning up old commits** — list stale entries and delete them

## Convention

`VERS_INFRA_URL` env var points to the infra VM (e.g., `http://abc123.vm.vers.sh:3000`). All endpoints below are relative to this base URL.

## API Reference

### Record a Commit

```bash
curl -X POST "$VERS_INFRA_URL/commits" \
  -H "Content-Type: application/json" \
  -d '{
    "commitId": "abc123-commit-id",
    "vmId": "abc123-vm-id",
    "label": "golden-v5",
    "agent": "orchestrator",
    "tags": ["golden", "stable"],
    "metadata": {"nodeVersion": "22", "piVersion": "0.52.9"}
  }'
```

Returns `201` with the full entry (including generated `id` and `timestamp`). Returns `409` if `commitId` is already recorded.

Fields: `commitId` (required), `vmId` (required), `label` (optional — human-readable name), `agent` (optional — who made the commit), `tags` (optional — array of strings), `metadata` (optional — arbitrary key/value data).

### List Commits

```bash
# All commits (newest first)
curl "$VERS_INFRA_URL/commits"

# Filter by tag
curl "$VERS_INFRA_URL/commits?tag=golden"

# Filter by agent
curl "$VERS_INFRA_URL/commits?agent=orchestrator"

# Filter by label
curl "$VERS_INFRA_URL/commits?label=infra"

# Filter by source VM
curl "$VERS_INFRA_URL/commits?vmId=abc123-vm-id"

# Filter by time (ISO timestamp)
curl "$VERS_INFRA_URL/commits?since=2026-02-10T00:00:00Z"

# Combine filters
curl "$VERS_INFRA_URL/commits?tag=golden&agent=orchestrator"
```

Returns `{ commits: [...], count: N }`. Results are sorted newest first.

### Get a Single Commit

```bash
curl "$VERS_INFRA_URL/commits/abc123-commit-id"
```

Returns the commit entry or `404`.

### Delete a Commit

```bash
curl -X DELETE "$VERS_INFRA_URL/commits/abc123-commit-id"
```

Returns `{ deleted: true }` or `404`.

## Common Patterns

### Record After vers_vm_commit

Every time you snapshot a VM, record it in the ledger:

```bash
# 1. Commit the VM via Vers API
COMMIT_ID=$(vers_vm_commit --vmId $VM_ID)

# 2. Record in the ledger
curl -X POST "$VERS_INFRA_URL/commits" \
  -H "Content-Type: application/json" \
  -d "{
    \"commitId\": \"$COMMIT_ID\",
    \"vmId\": \"$VM_ID\",
    \"label\": \"golden-v5\",
    \"agent\": \"orchestrator\",
    \"tags\": [\"golden\", \"stable\"]
  }"
```

### Golden Image Management

Tag golden images so you can find the latest one:

```bash
# Find the latest golden image
curl -s "$VERS_INFRA_URL/commits?tag=golden" | jq '.commits[0]'

# Find all stable golden images
curl -s "$VERS_INFRA_URL/commits?tag=golden&tag=stable"

# Mark a golden image as broken (delete and re-record, or just record a new one)
curl -X DELETE "$VERS_INFRA_URL/commits/old-broken-commit"
```

### Snapshot Before Risky Changes

Before doing something that might break the VM, commit and record:

```bash
# Snapshot as a rollback point
curl -X POST "$VERS_INFRA_URL/commits" \
  -H "Content-Type: application/json" \
  -d '{
    "commitId": "'$COMMIT_ID'",
    "vmId": "'$VM_ID'",
    "label": "pre-deploy-backup",
    "agent": "lt-infra",
    "tags": ["backup", "rollback-point"]
  }'
```

### Find a Commit to Roll Back To

```bash
# What snapshots did lt-infra make today?
curl -s "$VERS_INFRA_URL/commits?agent=lt-infra&since=2026-02-10T00:00:00Z" | jq '.commits[] | {commitId, label, timestamp}'

# Find the last known-good infra snapshot
curl -s "$VERS_INFRA_URL/commits?label=infra&tag=stable" | jq '.commits[0].commitId'
```

### Clean Up Stale Commits

```bash
# List old commits and delete ones no longer needed
curl -s "$VERS_INFRA_URL/commits" | jq '.commits[] | {commitId, label, timestamp}'

# Delete a stale entry
curl -X DELETE "$VERS_INFRA_URL/commits/old-commit-id"
```

## Suggested Tagging Conventions

Use consistent tags so queries work across agents:

| Tag | Meaning |
|-----|---------|
| `golden` | Golden image — ready to branch workers/lieutenants from |
| `stable` | Known working state |
| `broken` | Known broken — don't use |
| `wip` | Work in progress, not yet validated |
| `backup` | Safety snapshot before a risky operation |
| `rollback-point` | Explicit rollback target |

## Commit Entry Schema

```typescript
interface CommitEntry {
  id: string;                        // ULID (auto-generated)
  commitId: string;                  // Vers commit ID (from vers_vm_commit)
  vmId: string;                      // Vers VM ID that was committed
  timestamp: string;                 // ISO timestamp (auto-generated)
  label?: string;                    // Human-readable name
  agent?: string;                    // Who made the commit
  tags?: string[];                   // Categorization tags
  metadata?: Record<string, unknown>; // Arbitrary extra data
}
```

## Storage

Commits are persisted in `data/commits.jsonl` (append-only JSONL). Each line is one JSON entry. Deletes trigger a full rewrite.
