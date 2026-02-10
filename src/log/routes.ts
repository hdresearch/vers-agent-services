import { Hono } from "hono";
import { LogStore, ValidationError } from "./store.js";

const store = new LogStore();

export const logRoutes = new Hono();

// POST / — Append a log entry
logRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const entry = store.append(body);
    return c.json(entry, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET / — Query entries (JSON)
logRoutes.get("/", (c) => {
  const since = c.req.query("since");
  const until = c.req.query("until");
  const last = c.req.query("last");

  const entries = store.query({ since, until, last });
  return c.json({ entries, count: entries.length });
});

// GET /raw — Query entries (plain text)
logRoutes.get("/raw", (c) => {
  const since = c.req.query("since");
  const until = c.req.query("until");
  const last = c.req.query("last");

  const entries = store.query({ since, until, last });
  const text = store.formatRaw(entries);
  return c.text(text);
});
