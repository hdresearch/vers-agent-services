import { Hono } from "hono";
import { SubFleetStore } from "./store.js";
import { SubFleetOrchestrator } from "./orchestrator.js";
import { VersClient } from "./vers-client.js";

// ── Shared instances ─────────────────────────────────────────────────────────

export const subfleetStore = new SubFleetStore();

const versApiKey = process.env.VERS_API_KEY || "";

const versClient = new VersClient({
  apiBase: process.env.VERS_API_BASE || "https://api.vers.sh/api/v1",
  apiKey: versApiKey,
});

// Lazy import aegis to avoid circular — check if available
let isProtected: ((vmId: string) => boolean) | undefined;
try {
  // Will be set from server.ts via setAegisGuard()
} catch {}

export function setAegisGuard(fn: (vmId: string) => boolean): void {
  isProtected = fn;
}

export const subfleetOrchestrator = new SubFleetOrchestrator({
  store: subfleetStore,
  versClient,
  get isProtected() {
    return isProtected;
  },
  reaperIntervalMs: 60_000,
});

// Start TTL reaper
subfleetOrchestrator.startReaper();

// ── Routes ───────────────────────────────────────────────────────────────────

export const subfleetRoutes = new Hono();

// POST /subfleet/create — create a new sub-fleet
subfleetRoutes.post("/create", async (c) => {
  try {
    const body = await c.req.json();
    const { name, purpose, goldenCommit, vmCount, ttlHours } = body;

    // Validate
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required (string)" }, 400);
    }
    if (!purpose || typeof purpose !== "string") {
      return c.json({ error: "purpose is required (string)" }, 400);
    }
    if (!goldenCommit || typeof goldenCommit !== "string") {
      return c.json({ error: "goldenCommit is required (string)" }, 400);
    }
    if (!vmCount || typeof vmCount !== "number" || vmCount < 1 || vmCount > 20) {
      return c.json({ error: "vmCount must be 1-20" }, 400);
    }
    if (!ttlHours || typeof ttlHours !== "number" || ttlHours < 0.5 || ttlHours > 72) {
      return c.json({ error: "ttlHours must be 0.5-72" }, 400);
    }

    const result = await subfleetOrchestrator.create({
      name,
      purpose,
      goldenCommit,
      vmCount,
      ttlHours,
    });

    return c.json(result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// GET /subfleet/list — list all active sub-fleets
subfleetRoutes.get("/list", (c) => {
  const fleets = subfleetStore.listActive();
  return c.json({ fleets });
});

// GET /subfleet/:id/status — status of a sub-fleet and its VMs
subfleetRoutes.get("/:id/status", (c) => {
  const id = c.req.param("id");
  const status = subfleetOrchestrator.getStatus(id);
  if (!status) {
    return c.json({ error: "Sub-fleet not found" }, 404);
  }
  return c.json(status);
});

// POST /subfleet/:id/extend — extend TTL
subfleetRoutes.post("/:id/extend", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { hours } = body;

    if (!hours || typeof hours !== "number" || hours < 0.5 || hours > 72) {
      return c.json({ error: "hours must be 0.5-72" }, 400);
    }

    const fleet = subfleetStore.extendTTL(id, hours);
    if (!fleet) {
      return c.json({ error: "Sub-fleet not found or not active" }, 404);
    }

    return c.json({
      subfleetId: fleet.id,
      expiresAt: fleet.expiresAt,
      ttlHours: fleet.ttlHours,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// DELETE /subfleet/:id — destroy a sub-fleet
subfleetRoutes.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const fleet = subfleetStore.get(id);
    if (!fleet) {
      return c.json({ error: "Sub-fleet not found" }, 404);
    }
    if (fleet.status === "destroyed") {
      return c.json({ error: "Sub-fleet already destroyed" }, 400);
    }

    const result = await subfleetOrchestrator.destroy(id);
    return c.json({
      subfleetId: id,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// GET /subfleet/audit — audit log
subfleetRoutes.get("/audit", (c) => {
  const subfleetId = c.req.query("subfleetId");
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const log = subfleetStore.getAuditLog(subfleetId, limit);
  return c.json({ log });
});
