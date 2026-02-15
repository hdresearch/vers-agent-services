import { Hono } from "hono";
import { CouchStore, NotFoundError, ValidationError, ConflictError } from "./store.js";
import { VersClient } from "./vers-client.js";
import { emit } from "../events/emit.js";
import { ConfigStore } from "../config/store.js";

export const couchStore = new CouchStore();
const configStore = new ConfigStore();

function getVersClient(): VersClient | null {
  const entry = configStore.get("VERS_API_KEY");
  if (!entry?.value) return null;
  return new VersClient(entry.value);
}

function getGoldenCommitId(): string | null {
  const entry = configStore.get("GOLDEN_COMMIT_ID");
  return entry?.value || null;
}

/** Provision a VM for a guest — runs in background after redeem */
async function provisionGuestVM(guestId: string, guestName: string): Promise<void> {
  const client = getVersClient();
  const goldenCommit = getGoldenCommitId();

  if (!client || !goldenCommit) {
    emit("couch", "couch.provision.failed", {
      guestId,
      error: !client ? "VERS_API_KEY not configured" : "GOLDEN_COMMIT_ID not configured",
    });
    return;
  }

  try {
    // Spawn VM from golden commit
    const vm = await client.restoreFromCommit(goldenCommit);
    const endpoint = `https://${vm.vm_id}.vm.vers.sh`;

    // Vers VMs from commits boot in ~2s — activate immediately
    // The guest can poll /couch/status until SSH responds
    couchStore.activateGuest(guestId, vm.vm_id, endpoint);

    emit("couch", "couch.guest.activated", {
      guestId,
      guestName,
      vmId: vm.vm_id,
      agentEndpoint: endpoint,
    });

    console.log(`[couch] Guest ${guestName} provisioned → VM ${vm.vm_id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("couch", "couch.provision.failed", { guestId, guestName, error: msg });
    console.error(`[couch] Failed to provision VM for guest ${guestName}: ${msg}`);
  }
}

export const couchRoutes = new Hono();

// Public routes — mounted BEFORE bearer auth in server.ts
export const couchPublicRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET /status?token=guest_xxx — Guest checks their own status (public, token-authed)
// ---------------------------------------------------------------------------
couchPublicRoutes.get("/status", (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "token query parameter required" }, 400);

  const guest = couchStore.getGuestByToken(token);
  if (!guest) return c.json({ error: "invalid or expired token" }, 404);

  return c.json({
    guestId: guest.id,
    name: guest.name,
    status: guest.status,
    vmId: guest.vmId ?? null,
    agentEndpoint: guest.agentEndpoint ?? null,
    resourceLimits: guest.resourceLimits,
    permissions: guest.permissions,
    resourceUsage: guest.resourceUsage,
    expiresAt: guest.expiresAt,
  });
});

// ---------------------------------------------------------------------------
// POST /invites — Generate a single-use invite (auth required — applied in server.ts)
// ---------------------------------------------------------------------------
couchRoutes.post("/invites", async (c) => {
  try {
    const body = await c.req.json();
    const invite = couchStore.createInvite(body);
    emit("couch", "couch.invite.created", {
      inviteId: invite.id,
      label: invite.label,
      expiresAt: invite.expiresAt,
    }, invite.createdBy);
    return c.json(invite, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /invites — List invites (auth required)
// ---------------------------------------------------------------------------
couchRoutes.get("/invites", (c) => {
  const status = c.req.query("status");
  const invites = couchStore.listInvites(status as any);
  return c.json({ invites, count: invites.length });
});

// ---------------------------------------------------------------------------
// DELETE /invites/:id — Revoke an invite (auth required)
// ---------------------------------------------------------------------------
couchRoutes.delete("/invites/:id", (c) => {
  try {
    const invite = couchStore.revokeInvite(c.req.param("id"));
    emit("couch", "couch.invite.revoked", { inviteId: invite.id }, invite.createdBy);
    return c.json(invite);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /redeem — Guest redeems an invite (NO auth — this is the public door)
// Mounted via couchPublicRoutes BEFORE bearer auth in server.ts.
// ---------------------------------------------------------------------------
couchPublicRoutes.post("/redeem", async (c) => {
  try {
    const body = await c.req.json();
    const guest = couchStore.redeemInvite(body);

    emit("couch", "couch.invite.redeemed", {
      guestId: guest.id,
      guestName: guest.name,
      inviteId: guest.inviteId,
    }, guest.name);

    // Fire-and-forget VM provisioning — guest gets immediate response with
    // "provisioning" status, then polls /guests/:id/status until "running"
    provisionGuestVM(guest.id, guest.name).catch((err) => {
      console.error(`[couch] Background provisioning error for ${guest.name}:`, err);
    });

    return c.json({
      guestId: guest.id,
      status: guest.status,
      authToken: guest.authToken,
      resourceLimits: guest.resourceLimits,
      permissions: guest.permissions,
      expiresAt: guest.expiresAt,
      // agentEndpoint will be populated once VM is provisioned
      agentEndpoint: guest.agentEndpoint ?? null,
    }, 201);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /guests — List active guests (auth required)
// ---------------------------------------------------------------------------
couchRoutes.get("/guests", (c) => {
  const status = c.req.query("status");
  const guests = couchStore.listGuests(status as any);
  // Strip auth tokens from list view
  const safe = guests.map(({ authToken, ...rest }) => rest);
  return c.json({ guests: safe, count: safe.length });
});

// ---------------------------------------------------------------------------
// GET /guests/:id/status — Resource usage for a guest (auth required)
// ---------------------------------------------------------------------------
couchRoutes.get("/guests/:id/status", (c) => {
  const guest = couchStore.getGuest(c.req.param("id"));
  if (!guest) return c.json({ error: "guest not found" }, 404);

  const limits = couchStore.checkLimits(guest.id);

  return c.json({
    id: guest.id,
    name: guest.name,
    status: guest.status,
    vmId: guest.vmId,
    agentEndpoint: guest.agentEndpoint,
    resourceUsage: guest.resourceUsage,
    resourceLimits: guest.resourceLimits,
    limitsExceeded: limits.exceeded,
    violations: limits.violations,
    createdAt: guest.createdAt,
    expiresAt: guest.expiresAt,
    stoppedAt: guest.stoppedAt,
  });
});

// ---------------------------------------------------------------------------
// DELETE /guests/:id — Kill switch (auth required)
// ---------------------------------------------------------------------------
couchRoutes.delete("/guests/:id", (c) => {
  try {
    const guest = couchStore.killGuest(c.req.param("id"));
    emit("couch", "couch.guest.killed", {
      guestId: guest.id,
      guestName: guest.name,
      vmId: guest.vmId,
    });

    // Destroy the Vers VM if one was provisioned
    if (guest.vmId) {
      const client = getVersClient();
      if (client) {
        client.deleteVM(guest.vmId).catch((err) => {
          console.error(`[couch] Failed to destroy VM ${guest.vmId}:`, err);
        });
      }
    }

    return c.json({ id: guest.id, status: guest.status, stoppedAt: guest.stoppedAt });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// POST /guests/:id/activate — Internal: mark guest as running after VM spawn
// (auth required — only the host orchestrator calls this)
// ---------------------------------------------------------------------------
couchRoutes.post("/guests/:id/activate", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.vmId?.trim()) return c.json({ error: "vmId is required" }, 400);
    if (!body.agentEndpoint?.trim()) return c.json({ error: "agentEndpoint is required" }, 400);

    const guest = couchStore.activateGuest(
      c.req.param("id"),
      body.vmId.trim(),
      body.agentEndpoint.trim(),
    );

    emit("couch", "couch.guest.activated", {
      guestId: guest.id,
      guestName: guest.name,
      vmId: guest.vmId,
      agentEndpoint: guest.agentEndpoint,
    });

    return c.json(guest);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// PUT /guests/:id/usage — Internal: update resource usage counters
// (auth required — called by monitoring/watchdog)
// ---------------------------------------------------------------------------
couchRoutes.put("/guests/:id/usage", async (c) => {
  try {
    const body = await c.req.json();
    const guest = couchStore.updateUsage(c.req.param("id"), body);

    // Auto-check limits after usage update
    const limits = couchStore.checkLimits(guest.id);
    if (limits.exceeded) {
      emit("couch", "couch.guest.limits_exceeded", {
        guestId: guest.id,
        guestName: guest.name,
        violations: limits.violations,
      });
    }

    return c.json({
      id: guest.id,
      resourceUsage: guest.resourceUsage,
      limitsExceeded: limits.exceeded,
      violations: limits.violations,
    });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});






