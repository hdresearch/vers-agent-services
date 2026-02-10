import { Hono } from "hono";
import { UsageStore, ValidationError, type VMRole } from "./store.js";

const store = new UsageStore();

export const usageRoutes = new Hono();

// POST /sessions — record a session
usageRoutes.post("/sessions", async (c) => {
  try {
    const body = await c.req.json();
    const record = await store.recordSession(body);
    return c.json(record, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// POST /vms — record a VM lifecycle event
usageRoutes.post("/vms", async (c) => {
  try {
    const body = await c.req.json();
    const record = await store.recordVM(body);
    return c.json(record, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET / — usage summary
usageRoutes.get("/", async (c) => {
  const range = c.req.query("range") || "7d";
  const summary = await store.summary(range);
  return c.json(summary);
});

// GET /sessions — list sessions
usageRoutes.get("/sessions", async (c) => {
  const agent = c.req.query("agent");
  const range = c.req.query("range");

  const sessions = await store.listSessions({
    agent: agent || undefined,
    range: range || undefined,
  });
  return c.json({ sessions, count: sessions.length });
});

// GET /vms — list VM records
usageRoutes.get("/vms", async (c) => {
  const role = c.req.query("role") as VMRole | undefined;
  const agent = c.req.query("agent");
  const range = c.req.query("range");

  const vms = await store.listVMs({
    role: role || undefined,
    agent: agent || undefined,
    range: range || undefined,
  });
  return c.json({ vms, count: vms.length });
});
