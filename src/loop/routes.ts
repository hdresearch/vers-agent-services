import { Hono } from "hono";
import { LoopStore } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";

export const loopStore = new LoopStore();
export const loopRoutes = new Hono();

// GET /status — Current loop status
loopRoutes.get("/status", (c) => {
  return c.json(loopStore.getStatus());
});

// POST /start — Start the loop
loopRoutes.post("/start", (c) => {
  try {
    const status = loopStore.start();
    emit("loop", "loop.started", { roles: status.roles.filter((r) => r.enabled).map((r) => r.name) }, "loop-runner");
    return c.json(status);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST /stop — Stop the loop
loopRoutes.post("/stop", (c) => {
  try {
    const status = loopStore.stop();
    emit("loop", "loop.stopped", {}, "loop-runner");
    return c.json(status);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /config — Get role configs
loopRoutes.get("/config", (c) => {
  return c.json({ roles: loopStore.getConfig() });
});

// PATCH /config/:name — Update a role config
loopRoutes.patch("/config/:name", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const name = c.req.param("name");
    const patch = body as Record<string, unknown>;
    const role = loopStore.patchConfig(name, {
      enabled: patch.enabled as boolean | undefined,
      intervalMs: patch.intervalMs as number | undefined,
      description: patch.description as string | undefined,
      task: patch.task as string | undefined,
    });
    emit("loop", "loop.config.updated", { role: role.name, enabled: role.enabled, intervalMs: role.intervalMs }, "loop-runner");
    return c.json(role);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /runs — Recent run records
loopRoutes.get("/runs", (c) => {
  const role = c.req.query("role");
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 20;
  const runs = loopStore.getRuns(role || undefined, limit);
  return c.json({ runs, count: runs.length });
});
