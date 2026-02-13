---
name: commit-discipline
description: Always register VM snapshots in the commit ledger. Use when committing/snapshotting VMs, before destroying VMs, during deploys, or when creating golden images. Ensures no snapshot goes untracked.
---

# Commit Discipline

Every `vers_vm_commit` MUST be followed by a commit ledger registration. No exceptions.

## When to Register

- **Before deploys** — pre-deploy backup snapshot
- **After deploys** — post-deploy working state
- **Before destroying agent VMs** — preserve session for forensics
- **Golden image builds** — the golden commit
- **Any manual snapshot** — if you committed it, register it

## How

After `vers_vm_commit` returns a commit ID:

```bash
curl -s -X POST "https://<INFRA_VM_ADDRESS>:3000/commits" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "commitId": "<commit-id-from-vers>",
    "vmId": "<vm-id>",
    "label": "<human-readable description>",
    "agent": "<your-agent-name>",
    "tags": ["<relevant>", "<tags>"]
  }'
```

## Tag Conventions

| Tag | When |
|---|---|
| `golden` | Golden image commits |
| `pre-deploy` | Before deploying to a VM |
| `post-deploy` | After successful deploy |
| `agent-session` | LT/worker VM before destruction |
| `infrastructure` | Infra VM snapshots |
| `backup` | Periodic backups |
| `forensics` | Snapshot of a dead/zombie agent for investigation |

## Extra Metadata in Label

Include enough context that someone reading the ledger later can understand what this snapshot contains:

- **Golden images**: tools installed, versions, what's configured
- **Agent sessions**: agent name, task ID, outcome (completed/zombie/crashed)
- **Deploys**: git SHA deployed, which service

## Anti-Pattern

❌ `vers_vm_commit` without registering = ghost snapshot. Nobody can find it later. You WILL forget the commit ID and it's lost forever.

✅ Commit → register → then proceed with whatever you were doing.
