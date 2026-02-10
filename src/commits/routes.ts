import { Hono } from "hono";
import { CommitStore, ValidationError, ConflictError, type CommitFilters } from "./store.js";

export const commitStore = new CommitStore();

export const commitRoutes = new Hono();

// POST / — Record a commit
commitRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const entry = commitStore.record(body);
    return c.json(entry, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

// GET / — List commits with optional filters
commitRoutes.get("/", (c) => {
  const filters: CommitFilters = {};
  const tag = c.req.query("tag");
  const agent = c.req.query("agent");
  const label = c.req.query("label");
  const since = c.req.query("since");
  const vmId = c.req.query("vmId");

  if (tag) filters.tag = tag;
  if (agent) filters.agent = agent;
  if (label) filters.label = label;
  if (since) filters.since = since;
  if (vmId) filters.vmId = vmId;

  const commits = commitStore.list(filters);
  return c.json({ commits, count: commits.length });
});

// GET /:id — Get a single commit by commitId
commitRoutes.get("/:id", (c) => {
  const entry = commitStore.get(c.req.param("id"));
  if (!entry) return c.json({ error: "Commit not found" }, 404);
  return c.json(entry);
});

// DELETE /:id — Remove a commit entry
commitRoutes.delete("/:id", (c) => {
  const deleted = commitStore.remove(c.req.param("id"));
  if (!deleted) return c.json({ error: "Commit not found" }, 404);
  return c.json({ deleted: true });
});
