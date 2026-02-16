import { Hono } from "hono";
import { AegisStore } from "./store.js";
import { BudgetBreaker } from "./budget.js";
import { SpawnLimiter } from "./spawn.js";
import { ProtectedGuard } from "./protected.js";

// ── Shared instances ─────────────────────────────────────────────────────────

export const aegisStore = new AegisStore();
export const budgetBreaker = new BudgetBreaker(aegisStore);
export const spawnLimiter = new SpawnLimiter(aegisStore);
export const protectedGuard = new ProtectedGuard(aegisStore);

// ── Routes ───────────────────────────────────────────────────────────────────

export const aegisRoutes = new Hono();

// ── Budget Routes ────────────────────────────────────────────────────────────

// GET /aegis/budget — get current config
aegisRoutes.get("/budget", (c) => {
  return c.json({ config: budgetBreaker.getConfig() });
});

// POST /aegis/budget/config — update budget config
aegisRoutes.post("/budget/config", async (c) => {
  try {
    const body = await c.req.json();
    const { maxTokensPerHour, maxTokensPerDay, maxCostPerDay } = body;
    const update: Record<string, number> = {};
    if (maxTokensPerHour !== undefined) update.maxTokensPerHour = Number(maxTokensPerHour);
    if (maxTokensPerDay !== undefined) update.maxTokensPerDay = Number(maxTokensPerDay);
    if (maxCostPerDay !== undefined) update.maxCostPerDay = Number(maxCostPerDay);

    if (Object.keys(update).length === 0) {
      return c.json({ error: "No valid config fields provided" }, 400);
    }

    const config = budgetBreaker.setConfig(update);
    return c.json({ config });
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// GET /aegis/budget/status — get budget status (optional ?agent= param)
aegisRoutes.get("/budget/status", (c) => {
  const agentId = c.req.query("agent");
  if (agentId) {
    return c.json({ status: budgetBreaker.agentStatus(agentId) });
  }
  return c.json({ status: budgetBreaker.globalStatus() });
});

// POST /aegis/budget/record — record token usage
aegisRoutes.post("/budget/record", async (c) => {
  try {
    const body = await c.req.json();
    const { agentId, tokens, costCents } = body;
    if (!agentId || tokens === undefined) {
      return c.json({ error: "agentId and tokens are required" }, 400);
    }
    const result = budgetBreaker.record(agentId, Number(tokens), Number(costCents ?? 0));
    return c.json(result);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// POST /aegis/budget/check — pre-flight budget check
aegisRoutes.post("/budget/check", async (c) => {
  try {
    const body = await c.req.json();
    const { agentId } = body;
    const result = budgetBreaker.check(agentId);
    return c.json(result);
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// ── Spawn Routes ─────────────────────────────────────────────────────────────

// GET /aegis/spawn/status — get spawn status
aegisRoutes.get("/spawn/status", (c) => {
  return c.json({ status: spawnLimiter.getStatus() });
});

// POST /aegis/spawn/config — update spawn config
aegisRoutes.post("/spawn/config", async (c) => {
  try {
    const body = await c.req.json();
    const { maxConcurrentVMs, maxSpawnsPerHour, circuitBreakerThreshold } = body;
    const update: Record<string, number> = {};
    if (maxConcurrentVMs !== undefined) update.maxConcurrentVMs = Number(maxConcurrentVMs);
    if (maxSpawnsPerHour !== undefined) update.maxSpawnsPerHour = Number(maxSpawnsPerHour);
    if (circuitBreakerThreshold !== undefined) update.circuitBreakerThreshold = Number(circuitBreakerThreshold);

    if (Object.keys(update).length === 0) {
      return c.json({ error: "No valid config fields provided" }, 400);
    }

    const config = spawnLimiter.setConfig(update);
    return c.json({ config });
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// POST /aegis/spawn/check — pre-flight spawn check
aegisRoutes.post("/spawn/check", (c) => {
  const result = spawnLimiter.canSpawn();
  return c.json(result);
});

// POST /aegis/spawn/record — record a spawn event
aegisRoutes.post("/spawn/record", async (c) => {
  try {
    const body = await c.req.json();
    const { vmId, agentId, action } = body;
    if (!vmId || !agentId || !action) {
      return c.json({ error: "vmId, agentId, and action are required" }, 400);
    }
    if (!["spawn", "destroy", "failure"].includes(action)) {
      return c.json({ error: "action must be spawn, destroy, or failure" }, 400);
    }

    if (action === "spawn") {
      const result = spawnLimiter.recordSpawn(vmId, agentId);
      return c.json(result);
    } else if (action === "destroy") {
      spawnLimiter.recordDestroy(vmId, agentId);
      return c.json({ ok: true });
    } else {
      const result = spawnLimiter.recordFailure(vmId, agentId);
      return c.json(result);
    }
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// POST /aegis/spawn/reset — reset circuit breaker
aegisRoutes.post("/spawn/reset", (c) => {
  const status = spawnLimiter.resetCircuitBreaker();
  return c.json({ status, message: "Circuit breaker reset" });
});

// ── Protected Resources Routes ───────────────────────────────────────────────

// GET /aegis/protected — list protected resources
aegisRoutes.get("/protected", (c) => {
  return c.json({ resources: protectedGuard.list() });
});

// POST /aegis/protected — add a protected resource
aegisRoutes.post("/protected", async (c) => {
  try {
    const body = await c.req.json();
    const { vmId, label, reason, addedBy } = body;
    if (!vmId || !label) {
      return c.json({ error: "vmId and label are required" }, 400);
    }
    try {
      const resource = protectedGuard.add(vmId, label, reason ?? "Protected via API", addedBy ?? "unknown");
      return c.json(resource, 201);
    } catch (e: unknown) {
      // UNIQUE constraint violation means it's already protected
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        return c.json({ error: `VM ${vmId} is already protected` }, 409);
      }
      throw e;
    }
  } catch (e: unknown) {
    if (e instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    throw e;
  }
});

// DELETE /aegis/protected/:id — remove a protected resource
aegisRoutes.delete("/protected/:id", (c) => {
  const id = c.req.param("id");
  const removed = protectedGuard.remove(id);
  if (!removed) {
    return c.json({ error: "Resource not found" }, 404);
  }
  return c.json({ ok: true, message: `Protection removed for resource ${id}` });
});

// POST /aegis/protected/check — check if a VM can be deleted
aegisRoutes.post("/protected/check", async (c) => {
  try {
    const body = await c.req.json();
    const { vmId } = body;
    if (!vmId) {
      return c.json({ error: "vmId is required" }, 400);
    }
    return c.json(protectedGuard.canDelete(vmId));
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// ── Audit Log ────────────────────────────────────────────────────────────────

aegisRoutes.get("/audit", (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  return c.json({ entries: aegisStore.getAuditLog(limit) });
});
