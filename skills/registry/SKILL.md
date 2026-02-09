# VM Registry

Service discovery for persistent Vers VMs. Agents register themselves so other agents can find them without hardcoded addresses.

## When to Use

- **After spawning a persistent VM** (lieutenant, infra) — register it so others can discover it
- **When you need to find a service** — discover the infra VM to get board/feed URLs, find lieutenants by role
- **After session recovery** — re-discover infrastructure instead of relying on stale state
- **When setting up heartbeats** — keep your VM's registration alive

## Convention

`VERS_INFRA_URL` env var points to the infra VM running agent-services (e.g., `http://abc123.vm.vers.sh:3000`). All endpoints below are relative to this base URL.

## API Reference

### Register a VM

```bash
curl -X POST "$VERS_INFRA_URL/registry/vms" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "abc-123-def",
    "name": "billing-lt",
    "role": "lieutenant",
    "address": "abc-123-def.vm.vers.sh",
    "registeredBy": "orchestrator",
    "services": [{"name": "pi-rpc", "port": 3001}],
    "metadata": {"task": "process invoices"}
  }'
```

Returns `201` with the full entry. Returns `409` if the VM ID is already registered.

Fields: `id` (required, Vers VM UUID), `name` (required), `role` (required: `infra|lieutenant|worker|golden|custom`), `address` (required), `registeredBy` (required), `status` (default: `running`), `services` (optional), `metadata` (optional).

### List VMs

```bash
# All VMs
curl "$VERS_INFRA_URL/registry/vms"

# Filter by role
curl "$VERS_INFRA_URL/registry/vms?role=lieutenant"

# Filter by status
curl "$VERS_INFRA_URL/registry/vms?status=running"

# Combine filters
curl "$VERS_INFRA_URL/registry/vms?role=infra&status=running"
```

Returns `{ vms: [...], count: N }`. When filtering `status=running`, stale VMs (no heartbeat in 5 min) are excluded.

### Get a Single VM

```bash
curl "$VERS_INFRA_URL/registry/vms/abc-123-def"
```

### Update a VM

```bash
curl -X PATCH "$VERS_INFRA_URL/registry/vms/abc-123-def" \
  -H "Content-Type: application/json" \
  -d '{"status": "paused", "metadata": {"reason": "saving resources"}}'
```

Updatable fields: `name`, `status`, `address`, `services`, `metadata`.

### Deregister a VM

```bash
curl -X DELETE "$VERS_INFRA_URL/registry/vms/abc-123-def"
```

### Heartbeat

```bash
curl -X POST "$VERS_INFRA_URL/registry/vms/abc-123-def/heartbeat"
```

Returns `{ id, lastSeen }`. Updates the `lastSeen` timestamp.

### Discover by Role

```bash
# Find infra VM(s)
curl "$VERS_INFRA_URL/registry/discover/infra"

# Find all lieutenants
curl "$VERS_INFRA_URL/registry/discover/lieutenant"

# Find workers
curl "$VERS_INFRA_URL/registry/discover/worker"
```

Returns `{ vms: [...], count: N }`. Only returns `running`, non-stale VMs. This is the primary way agents find things.

## Common Patterns

### Register a Lieutenant After Creation

After `vers_lt_create`, register the lieutenant so other agents can discover it:

```bash
# After creating lieutenant "billing" on VM abc-123-def
curl -X POST "$VERS_INFRA_URL/registry/vms" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "abc-123-def",
    "name": "billing",
    "role": "lieutenant",
    "address": "abc-123-def.vm.vers.sh",
    "registeredBy": "orchestrator",
    "services": [{"name": "pi-rpc", "port": 3001}]
  }'
```

### Discover Infra to Find Board/Feed

```bash
INFRA=$(curl -s "$VERS_INFRA_URL/registry/discover/infra" | jq -r '.vms[0].address')
# Now use $INFRA to hit board/feed
curl "http://$INFRA:3000/board/tasks"
curl "http://$INFRA:3000/feed/events"
```

### Heartbeat Pattern

Send a heartbeat every 2 minutes. VMs are considered stale after 5 minutes without a heartbeat. Stale VMs are excluded from `discover` and `?status=running` queries.

```bash
# In a loop or cron — every 2 minutes
while true; do
  curl -s -X POST "$VERS_INFRA_URL/registry/vms/$MY_VM_ID/heartbeat"
  sleep 120
done
```

### Check for Stale VMs

List all VMs and check `lastSeen` to find VMs that may need cleanup:

```bash
curl -s "$VERS_INFRA_URL/registry/vms" | jq '.vms[] | select(.status == "running") | {id, name, lastSeen}'
```

### Self-Registration on Startup

The infra VM should register itself when starting agent-services:

```bash
VM_ID=$(hostname)  # or from Vers metadata
curl -X POST "http://localhost:3000/registry/vms" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"$VM_ID\",
    \"name\": \"infra\",
    \"role\": \"infra\",
    \"address\": \"$VM_ID.vm.vers.sh\",
    \"registeredBy\": \"self\",
    \"services\": [
      {\"name\": \"board\", \"port\": 3000, \"healthPath\": \"/health\"},
      {\"name\": \"feed\", \"port\": 3000, \"healthPath\": \"/health\"},
      {\"name\": \"registry\", \"port\": 3000, \"healthPath\": \"/health\"}
    ]
  }"
```

## Pi Tools

If the `agent-services` extension is loaded, use these tools instead of curl:

- **`registry_register`** — Register a VM entry
- **`registry_list`** — List/filter registered VMs
- **`registry_discover`** — Discover VMs by role (preferred over list for lookups)
- **`registry_heartbeat`** — Send a heartbeat for a VM

These tools use `VERS_INFRA_URL` automatically.

## VM Entry Schema

```typescript
interface RegisteredVM {
  id: string;              // Vers VM UUID
  name: string;            // Human/agent-readable name
  role: "infra" | "lieutenant" | "worker" | "golden" | "custom";
  status: "running" | "paused" | "stopped";
  address: string;         // e.g., "abc123.vm.vers.sh"
  services?: { name: string; port: number; healthPath?: string }[];
  metadata?: Record<string, unknown>;
  registeredBy: string;    // Who registered it
  registeredAt: string;    // ISO timestamp
  lastSeen: string;        // Updated by heartbeat
}
```
