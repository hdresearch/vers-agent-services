import { Hono } from "hono";
import { JournalStore, ValidationError } from "./store.js";

const store = new JournalStore();

export const journalRoutes = new Hono();

// POST / — Append a journal entry
journalRoutes.post("/", async (c) => {
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
journalRoutes.get("/", (c) => {
  const since = c.req.query("since");
  const until = c.req.query("until");
  const last = c.req.query("last");
  const author = c.req.query("author");
  const tag = c.req.query("tag");
  const raw = c.req.query("raw");

  const entries = store.query({ since, until, last, author, tag });

  if (raw === "true") {
    const text = store.formatRaw(entries);
    return c.text(text);
  }

  return c.json({ entries, count: entries.length });
});

// GET /raw — Query entries (plain text)
journalRoutes.get("/raw", (c) => {
  const since = c.req.query("since");
  const until = c.req.query("until");
  const last = c.req.query("last");
  const author = c.req.query("author");
  const tag = c.req.query("tag");

  const entries = store.query({ since, until, last, author, tag });
  const text = store.formatRaw(entries);
  return c.text(text);
});
