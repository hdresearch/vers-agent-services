import { Hono } from "hono";
import { CouchStore, NotFoundError, ValidationError, ConflictError } from "./store.js";
import { emit } from "../events/emit.js";

export const couchStore = new CouchStore();

export const couchRoutes = new Hono();

// Public routes — mounted BEFORE bearer auth in server.ts
export const couchPublicRoutes = new Hono();

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

    // In a full implementation, this is where we'd spawn a VM from the golden commit.
    // For now, return the guest record with a provisioning status.
    // The host's orchestrator picks this up and calls activateGuest() after VM creation.
    //
    // Future: integrate with Vers VM spawning:
    //   const vm = await versClient.createVM({ fromCommit: goldenCommitId, ... });
    //   couchStore.activateGuest(guest.id, vm.id, `https://${vm.id}.vm.vers.sh`);

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

    // Future: actually destroy the Vers VM here
    // await versClient.destroyVM(guest.vmId);

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
