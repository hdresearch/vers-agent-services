import { Hono } from "hono";
import { ConfigStore, ValidationError } from "./store.js";

const store = new ConfigStore();

export const configRoutes = new Hono();

// GET / — list all config entries (secrets masked)
configRoutes.get("/", (c) => {
  const entries = store.getAllMasked();
  return c.json({ entries, count: entries.length });
});

// GET /env — flat key-value object (sensitive keys filtered out)
// Security: never expose values containing KEY, TOKEN, SECRET, PASSWORD
configRoutes.get("/env", (c) => {
  const env = store.getEnv();
  const SENSITIVE_PATTERNS = /KEY|TOKEN|SECRET|PASSWORD/i;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SENSITIVE_PATTERNS.test(k)) {
      filtered[k] = v.length > 4 ? "***" + v.slice(-4) : "***";
    } else {
      filtered[k] = v;
    }
  }
  return c.json(filtered);
});

// GET /secrets/:key — reveal full secret value (dedicated endpoint for programmatic access)
configRoutes.get("/secrets/:key", (c) => {
  const key = c.req.param("key");
  const entry = store.get(key);
  if (!entry) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(entry);
});

// GET /:key — single entry (secrets are always masked in this endpoint)
configRoutes.get("/:key", (c) => {
  const key = c.req.param("key");
  const entry = store.get(key);
  if (!entry) {
    return c.json({ error: "not found" }, 404);
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
