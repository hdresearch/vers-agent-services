import { Hono } from "hono";
import { KBStore, ValidationError, NotFoundError } from "./store.js";
import type { KBFilters, KBEntryType, KBPriority } from "./store.js";
import { emit } from "../events/emit.js";

export const kbStore = new KBStore();
export const kbRoutes = new Hono();

// POST /entries — Create a KB entry
kbRoutes.post("/entries", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const entry = kbStore.create(body as any);
    emit("kb", "kb.entry.created", {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      source: entry.source,
    });
    return c.json(entry, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /entries — List/search KB entries
kbRoutes.get("/entries", (c) => {
  const filters: KBFilters = {};
  const type = c.req.query("type");
  const tag = c.req.query("tag");
  const priority = c.req.query("priority");
  const source = c.req.query("source");
  const search = c.req.query("search");
  const includeExpired = c.req.query("includeExpired");

  if (type) filters.type = type as KBEntryType;
  if (tag) filters.tag = tag;
  if (priority) filters.priority = priority as KBPriority;
  if (source) filters.source = source;
  if (search) filters.search = search;
  if (includeExpired === "true") filters.includeExpired = true;

  const entries = kbStore.list(filters);
  return c.json({ entries, count: entries.length });
});

// GET /entries/:id — Get a single entry
kbRoutes.get("/entries/:id", (c) => {
  try {
    const entry = kbStore.get(c.req.param("id"));
    return c.json(entry);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// PATCH /entries/:id — Update an entry
kbRoutes.patch("/entries/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const entry = kbStore.update(c.req.param("id"), body as any);
    emit("kb", "kb.entry.updated", { id: entry.id, title: entry.title });
    return c.json(entry);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// DELETE /entries/:id — Delete an entry
kbRoutes.delete("/entries/:id", (c) => {
  const deleted = kbStore.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "KB entry not found" }, 404);
  emit("kb", "kb.entry.deleted", { id: c.req.param("id") });
  return c.json({ deleted: true });
});

// GET /briefing — Compiled markdown briefing for agent injection
kbRoutes.get("/briefing", (c) => {
  const tagsParam = c.req.query("tags");
  const maxEntries = c.req.query("maxEntries");

  const opts: { tags?: string[]; maxEntries?: number } = {};
  if (tagsParam) opts.tags = tagsParam.split(",").map((t) => t.trim());
  if (maxEntries) opts.maxEntries = parseInt(maxEntries, 10);

  const briefing = kbStore.briefing(opts);
  // Return as plain text for direct file write, or JSON wrapper
  const format = c.req.query("format");
  if (format === "text") {
    return c.text(briefing);
  }
  return c.json({ briefing, entryCount: kbStore.size });
});

// GET /stats — KB statistics
kbRoutes.get("/stats", (c) => {
  return c.json(kbStore.stats());
});
