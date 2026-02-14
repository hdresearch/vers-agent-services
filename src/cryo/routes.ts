import { Hono } from "hono";
import {
  CryoStore,
  NotFoundError,
  ValidationError,
  ConflictError,
  type AgentFilters,
  type AgentStatus,
  type TrustLevel,
} from "./store.js";
import { emit } from "../events/emit.js";

export const cryoStore = new CryoStore();

export const cryoRoutes = new Hono();

// POST /agents — Register a new agent
cryoRoutes.post("/agents", async (c) => {
  try {
    const body = await c.req.json();
    const agent = cryoStore.createAgent(body);
    emit("cryo", "cryo.agent.created", { name: agent.name, persona: agent.persona, status: agent.status }, agent.name);
    return c.json(agent, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

// GET /agents — List agents (filterable)
cryoRoutes.get("/agents", (c) => {
  const filters: AgentFilters = {};
  const status = c.req.query("status");
  const persona = c.req.query("persona");
  const tag = c.req.query("tag");
  const trustLevel = c.req.query("trustLevel");

  if (status) filters.status = status as AgentStatus;
  if (persona) filters.persona = persona;
  if (tag) filters.tag = tag;
  if (trustLevel) filters.trustLevel = trustLevel as TrustLevel;

  const agents = cryoStore.listAgents(filters);
  return c.json({ agents, count: agents.length });
});

// GET /agents/:name — Get a single agent
cryoRoutes.get("/agents/:name", (c) => {
  try {
    const agent = cryoStore.getAgent(c.req.param("name"));
    return c.json(agent);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// PATCH /agents/:name — Update agent fields
cryoRoutes.patch("/agents/:name", async (c) => {
  try {
    const body = await c.req.json();
    const agent = cryoStore.updateAgent(c.req.param("name"), body);
    emit("cryo", "cryo.agent.updated", { name: agent.name }, agent.name);
    return c.json(agent);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// POST /agents/:name/hibernate — Put agent on ice
cryoRoutes.post("/agents/:name/hibernate", async (c) => {
  try {
    const body = await c.req.json();
    const agent = cryoStore.hibernate(c.req.param("name"), body);
    emit("cryo", "cryo.agent.hibernated", { name: agent.name, commitId: agent.latestCommitId }, agent.name);
    return c.json(agent);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// POST /agents/:name/wake — Thaw agent from cryosleep
cryoRoutes.post("/agents/:name/wake", async (c) => {
  try {
    const body = await c.req.json();
    const agent = cryoStore.wake(c.req.param("name"), body);
    emit("cryo", "cryo.agent.woken", { name: agent.name, vmId: agent.currentVmId }, agent.name);
    return c.json(agent);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// POST /agents/:name/retire — Permanently retire agent
cryoRoutes.post("/agents/:name/retire", (c) => {
  try {
    const agent = cryoStore.retire(c.req.param("name"));
    emit("cryo", "cryo.agent.retired", { name: agent.name }, agent.name);
    return c.json(agent);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// GET /agents/:name/history — Commit/snapshot history
cryoRoutes.get("/agents/:name/history", (c) => {
  try {
    const history = cryoStore.getHistory(c.req.param("name"));
    return c.json({ history, count: history.length });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// POST /agents/:name/events — Add a notable event
cryoRoutes.post("/agents/:name/events", async (c) => {
  try {
    const body = await c.req.json();
    const agent = cryoStore.addEvent(c.req.param("name"), body);
    return c.json(agent);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /agents/:name/briefing — Composed wake-up briefing
cryoRoutes.get("/agents/:name/briefing", (c) => {
  try {
    const briefing = cryoStore.composeBriefing(c.req.param("name"));
    return c.json({ briefing });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});
