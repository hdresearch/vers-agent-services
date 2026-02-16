/**
 * Autonomy Routes — API surface for the autonomous loop.
 *
 * GET  /autonomy/status        — full loop status
 * POST /autonomy/enable        — turn on the loop
 * POST /autonomy/disable       — turn off (safe mode)
 * GET  /autonomy/history       — recent autonomous actions
 * GET  /autonomy/pending       — things waiting for human decision
 * POST /autonomy/approve/:id   — human approves an escalation
 * POST /autonomy/reject/:id    — human rejects an escalation
 * GET  /autonomy/schedule      — view scheduled tasks
 * POST /autonomy/schedule      — update schedule config
 * POST /autonomy/run/:task     — trigger a scheduled task immediately
 */

import { Hono } from "hono";
import { AutonomyStore } from "./store.js";
import { EscalationEngine } from "./escalation.js";
import { Scheduler } from "./scheduler.js";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { eventLogStore } from "../events/store.js";
import { emit } from "../events/emit.js";

// ── Singleton wiring ─────────────────────────────────────────────────────────

const autonomyStore = new AutonomyStore();

const selfBaseUrl = `http://localhost:${process.env.PORT || "3000"}`;
const authToken = process.env.VERS_AUTH_TOKEN || "";

const escalation = new EscalationEngine({
  store: autonomyStore,
  selfBaseUrl,
  authToken,
});

const scheduler = new Scheduler({
  store: autonomyStore,
  selfBaseUrl,
  authToken,
});

const orchestratorDeps: OrchestratorDeps = {
  store: autonomyStore,
  eventStore: eventLogStore,
  escalation,
  scheduler,
  selfBaseUrl,
  authToken,
};

const orchestrator = new Orchestrator(orchestratorDeps);

export { orchestrator, autonomyStore, escalation, scheduler };

// ── Routes ───────────────────────────────────────────────────────────────────

export const autonomyRoutes = new Hono();

// GET /status — full loop status
autonomyRoutes.get("/status", (c) => {
  return c.json(orchestrator.getStatus());
});

// POST /enable — turn on the loop
autonomyRoutes.post("/enable", async (c) => {
  if (orchestrator.isEnabled) {
    return c.json({ message: "Autonomous loop already enabled", status: orchestrator.getStatus() });
  }
  await orchestrator.enable();
  emit("autonomy", "loop.enabled_via_api", {}, "api");
  return c.json({ message: "Autonomous loop enabled", status: orchestrator.getStatus() });
});

// POST /disable — turn off (safe mode)
autonomyRoutes.post("/disable", (c) => {
  if (!orchestrator.isEnabled) {
    return c.json({ message: "Autonomous loop already disabled", status: orchestrator.getStatus() });
  }
  orchestrator.disable();
  emit("autonomy", "loop.disabled_via_api", {}, "api");
  return c.json({ message: "Autonomous loop disabled — safe mode", status: orchestrator.getStatus() });
});

// GET /history — recent autonomous actions
autonomyRoutes.get("/history", (c) => {
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const actions = autonomyStore.getActions(limit);
  return c.json({ actions, count: actions.length });
});

// GET /pending — things waiting for human decision
autonomyRoutes.get("/pending", (c) => {
  const pending = escalation.getPending();
  return c.json({ escalations: pending, count: pending.length });
});

// POST /approve/:id — human approves an escalation
autonomyRoutes.post("/approve/:id", (c) => {
  const id = c.req.param("id");
  const esc = escalation.approve(id);
  if (!esc) {
    return c.json({ error: "Escalation not found or not pending" }, 404);
  }
  return c.json({ escalation: esc, message: "Approved" });
});

// POST /reject/:id — human rejects an escalation
autonomyRoutes.post("/reject/:id", (c) => {
  const id = c.req.param("id");
  const esc = escalation.reject(id);
  if (!esc) {
    return c.json({ error: "Escalation not found or not pending" }, 404);
  }
  return c.json({ escalation: esc, message: "Rejected" });
});

// GET /schedule — view scheduled tasks
autonomyRoutes.get("/schedule", (c) => {
  const schedule = autonomyStore.getSchedule();
  return c.json({ schedule, schedulerRunning: scheduler.isRunning });
});

// POST /schedule — update a schedule entry
autonomyRoutes.post("/schedule", async (c) => {
  try {
    const body = await c.req.json();
    const { name, intervalMs, enabled } = body as { name?: string; intervalMs?: number; enabled?: boolean };

    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    const entry = autonomyStore.updateScheduleEntry(name, {
      intervalMs: intervalMs !== undefined ? Number(intervalMs) : undefined,
      enabled: enabled !== undefined ? Boolean(enabled) : undefined,
    });

    if (!entry) {
      return c.json({ error: `Schedule entry '${name}' not found` }, 404);
    }

    // Reload scheduler to pick up changes
    scheduler.reload();

    return c.json({ entry, message: "Schedule updated" });
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// POST /run/:task — trigger a scheduled task immediately
autonomyRoutes.post("/run/:task", async (c) => {
  const task = c.req.param("task");
  try {
    await scheduler.runTask(task);
    return c.json({ message: `Task '${task}' executed`, task });
  } catch (err) {
    return c.json({ error: `Task '${task}' failed: ${(err as Error).message}` }, 500);
  }
});
