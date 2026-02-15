import { Hono } from "hono";
import { LoopStore, type RoleConfig } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";

/** Sentinel: check infra health */
async function sentinelTick(): Promise<void> {
  try {
    const res = await fetch("http://localhost:3000/health", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      emit("loop", "sentinel.unhealthy", { service: "agent-services", status: res.status });
    }
  } catch (err) {
    emit("loop", "sentinel.unreachable", {
      service: "agent-services",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Quartermaster: find unassigned open tasks */
async function quartermasterTick(): Promise<void> {
  try {
    const res = await fetch("http://localhost:3000/board/tasks?status=open&limit=20", {
      headers: { Authorization: `Bearer ${process.env.VERS_AUTH_TOKEN || ""}` },
    });
    if (!res.ok) return;
    const data = await res.json() as { tasks: any[] };
    const unassigned = data.tasks.filter((t: any) => !t.assignee);
    if (unassigned.length > 0) {
      emit("loop", "quartermaster.unassigned_tasks", {
        count: unassigned.length,
        sample: unassigned.slice(0, 5).map((t: any) => ({ id: t.id, title: t.title?.substring(0, 60) })),
      });
    }
  } catch { /* silent */ }
}

/** Scribe: summarize recent log activity */
async function scribeTick(): Promise<void> {
  try {
    const res = await fetch("http://localhost:3000/log?last=6h&limit=50", {
      headers: { Authorization: `Bearer ${process.env.VERS_AUTH_TOKEN || ""}` },
    });
    if (!res.ok) return;
    const data = await res.json() as { entries: any[] };
    if (data.entries.length > 0) {
      emit("loop", "scribe.activity_summary", {
        entriesLast6h: data.entries.length,
        agents: [...new Set(data.entries.map((e: any) => e.agent).filter(Boolean))],
      });
    }
  } catch { /* silent */ }
}

/** Auditor: detect stale in-progress tasks (>24h no update) */
async function auditorTick(): Promise<void> {
  try {
    const res = await fetch("http://localhost:3000/board/tasks?status=in_progress&limit=50", {
      headers: { Authorization: `Bearer ${process.env.VERS_AUTH_TOKEN || ""}` },
    });
    if (!res.ok) return;
    const data = await res.json() as { tasks: any[] };
    const now = Date.now();
    const stale = data.tasks.filter((t: any) => {
      const updated = new Date(t.updatedAt || t.createdAt).getTime();
      return now - updated > 24 * 60 * 60 * 1000;
    });
    if (stale.length > 0) {
      emit("loop", "auditor.stale_tasks", {
        count: stale.length,
        sample: stale.slice(0, 5).map((t: any) => ({ id: t.id, title: t.title?.substring(0, 60) })),
      });
    }
  } catch { /* silent */ }
}

const tickHandlers: Record<string, () => Promise<void>> = {
  health: sentinelTick,
  dispatch: quartermasterTick,
  docs: scribeTick,
  review: auditorTick,
};

async function onTick(role: RoleConfig): Promise<void> {
  const handler = tickHandlers[role.task];
  if (handler) await handler();
}

export const loopStore = new LoopStore("data/loop.json", onTick);
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

