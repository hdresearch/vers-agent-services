import { Hono } from "hono";
import { ConfigStore, ValidationError } from "./store.js";

const store = new ConfigStore();

export const configRoutes = new Hono();

// GET / — list all config entries (secrets masked)
configRoutes.get("/", (c) => {
  const entries = store.getAllMasked();
  return c.json({ entries, count: entries.length });
});

// GET /env — flat key-value object with full values (for agent env injection)
configRoutes.get("/env", (c) => {
  const env = store.getEnv();
  return c.json(env);
});

// GET /:key — single entry (masked unless ?reveal=true)
configRoutes.get("/:key", (c) => {
  const key = c.req.param("key");
  const reveal = c.req.query("reveal") === "true";

  const entry = store.get(key);
  if (!entry) {
    return c.json({ error: "not found" }, 404);
  }

  if (reveal || entry.type === "config") {
    return c.json(entry);
  }

  return c.json(store.getMasked(entry));
});

// PUT /:key — set value
configRoutes.put("/:key", async (c) => {
  const key = c.req.param("key");
  try {
    const body = await c.req.json();
    const { value, type } = body;
    const entry = store.set(key, value, type || "config");
    return c.json(entry);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof SyntaxError) return c.json({ error: "invalid JSON" }, 400);
    throw e;
  }
});

// DELETE /:key — delete
configRoutes.delete("/:key", (c) => {
  const key = c.req.param("key");
  const deleted = store.delete(key);
  if (!deleted) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ deleted: true, key });
});
