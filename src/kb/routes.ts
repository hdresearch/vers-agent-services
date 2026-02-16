import { Hono } from "hono";
import {
  KBStore,
  NotFoundError,
  ValidationError,
  type EntryType,
  type EntryFilters,
  VALID_ENTRY_TYPES,
} from "./store.js";
import { emit } from "../events/emit.js";

export const kbStore = new KBStore();

export const kbRoutes = new Hono();

// --- CRUD ---

// POST /kb/entries — create a knowledge entry
kbRoutes.post("/entries", async (c) => {
  try {
    const body = await c.req.json();
    const entry = kbStore.createEntry(body);
    emit("kb", "kb.entry.created", {
      entryId: entry.id,
      type: entry.type,
      tags: entry.tags,
    });
    return c.json(entry, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /kb/entries — list/search entries
kbRoutes.get("/entries", (c) => {
  const filters: EntryFilters = {};

  const type = c.req.query("type");
  const tag = c.req.query("tag");
  const active = c.req.query("active");
  const archived = c.req.query("archived");
  const search = c.req.query("search");

  if (type && VALID_ENTRY_TYPES.has(type)) filters.type = type as EntryType;
  if (tag) filters.tag = tag;
  if (active === "true") filters.active = true;
  if (active === "false") filters.active = false;
  if (archived !== undefined) filters.archived = archived === "true";
  if (search) filters.search = search;

  const entries = kbStore.listEntries(filters);
  return c.json({ entries, count: entries.length });
});

// GET /kb/entries/:id — get a single entry
kbRoutes.get("/entries/:id", (c) => {
  const entry = kbStore.getEntry(c.req.param("id"));
  if (!entry) return c.json({ error: "entry not found" }, 404);
  return c.json(entry);
});

// PATCH /kb/entries/:id — update an entry (reinforce, archive, edit)
kbRoutes.patch("/entries/:id", async (c) => {
  try {
    const body = await c.req.json();
    const entry = kbStore.updateEntry(c.req.param("id"), body);
    emit("kb", "kb.entry.updated", {
      entryId: entry.id,
      type: entry.type,
      reinforced: !!body.reinforce,
      archived: entry.archived,
    });
    return c.json(entry);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// --- Briefings ---

// GET /kb/briefing/session — composed session briefing
kbRoutes.get("/briefing/session", (c) => {
  const maxTokens = parseInt(c.req.query("maxTokens") || "4000", 10);
  const briefing = kbStore.sessionBriefing(maxTokens);
  const stats = kbStore.stats();
  return c.json({
    briefing,
    tokens: kbStore.estimateTokens(briefing),
    stats,
  });
});

// GET /kb/briefing/task?tags=deploy,infra — task-specific briefing
kbRoutes.get("/briefing/task", (c) => {
  const tagsParam = c.req.query("tags");
  if (!tagsParam) {
    return c.json({ error: "tags query parameter is required" }, 400);
  }
  const tags = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) {
    return c.json({ error: "at least one tag is required" }, 400);
  }
  const maxTokens = parseInt(c.req.query("maxTokens") || "4000", 10);
  const briefing = kbStore.taskBriefing(tags, maxTokens);
  return c.json({
    briefing,
    tokens: kbStore.estimateTokens(briefing),
    tags,
  });
});

// --- Extraction ---

// POST /kb/extract — extract knowledge entries from text
kbRoutes.post("/extract", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.text || typeof body.text !== "string") {
      return c.json({ error: "text field is required" }, 400);
    }
    const extracted = kbStore.extractFromText(body.text, body.source);

    // Optionally auto-create the extracted entries
    const created = [];
    if (body.autoCreate !== false) {
      for (const input of extracted) {
        const entry = kbStore.createEntry(input);
        created.push(entry);
      }
      if (created.length > 0) {
        emit("kb", "kb.entries.extracted", {
          count: created.length,
          source: body.source,
          types: created.map((e) => e.type),
        });
      }
    }

    return c.json({
      extracted: body.autoCreate === false ? extracted : undefined,
      created: body.autoCreate !== false ? created : undefined,
      count: extracted.length,
    });
  } catch (e) {
    throw e;
  }
});

// GET /kb/stats — knowledge base statistics
kbRoutes.get("/stats", (c) => {
  return c.json(kbStore.stats());
});
