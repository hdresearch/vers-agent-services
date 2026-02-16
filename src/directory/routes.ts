import { Hono } from "hono";
import { DirectoryStore } from "./store.js";
import type { CreatePersonInput, UpdatePersonInput, AddNoteInput, PersonType, TrustLevel } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";

// ── Store singleton ────────────────────────────────────────────────────────

export const directoryStore = new DirectoryStore();

// ── Routes ─────────────────────────────────────────────────────────────────

export const directoryRoutes = new Hono();

// POST /directory/people — Add a person
directoryRoutes.post("/people", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const person = directoryStore.create(body as CreatePersonInput);
    emit("directory", "directory.person.created", {
      personId: person.id,
      name: person.name,
      type: person.type,
    });
    return c.json(person, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /directory/people — List all (with optional search)
directoryRoutes.get("/people", (c) => {
  const q = c.req.query("q") || undefined;
  const type = c.req.query("type") as PersonType | undefined;
  const trustLevel = c.req.query("trustLevel") as TrustLevel | undefined;
  const people = directoryStore.list({ q, type, trustLevel });
  return c.json({ people, count: people.length });
});

// GET /directory/search — Full-text search across names, aliases, notes, tags
directoryRoutes.get("/search", (c) => {
  const q = c.req.query("q") || "";
  if (!q.trim()) {
    return c.json({ error: "q query parameter is required" }, 400);
  }

  try {
    const people = directoryStore.search(q);
    return c.json({ people, count: people.length, query: q });
  } catch (err: any) {
    // FTS can throw on bad syntax; fall back to LIKE search
    const people = directoryStore.list({ q });
    return c.json({ people, count: people.length, query: q, note: "fell back to simple search" });
  }
});

// GET /directory/graph — Relationship graph
directoryRoutes.get("/graph", (c) => {
  const graph = directoryStore.graph();
  return c.json(graph);
});

// GET /directory/people/:id — Full profile
directoryRoutes.get("/people/:id", (c) => {
  try {
    const person = directoryStore.get(c.req.param("id"));
    return c.json(person);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// PATCH /directory/people/:id — Update
directoryRoutes.patch("/people/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const person = directoryStore.update(c.req.param("id"), body as UpdatePersonInput);
    emit("directory", "directory.person.updated", {
      personId: person.id,
      name: person.name,
    });
    return c.json(person);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /directory/people/:id/notes — Add a note
directoryRoutes.post("/people/:id/notes", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const note = directoryStore.addNote(c.req.param("id"), body as AddNoteInput);
    emit("directory", "directory.note.added", {
      personId: c.req.param("id"),
      noteId: note.id,
      author: note.author,
    });
    return c.json(note, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// DELETE /directory/people/:id — Remove
directoryRoutes.delete("/people/:id", (c) => {
  try {
    directoryStore.delete(c.req.param("id"));
    emit("directory", "directory.person.deleted", { personId: c.req.param("id") });
    return c.json({ deleted: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /directory/relationships — Add a relationship edge
directoryRoutes.post("/relationships", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const { fromId, toId, relationship } = body;
    if (!fromId || !toId || !relationship) {
      return c.json({ error: "fromId, toId, and relationship are required" }, 400);
    }
    directoryStore.addRelationship(fromId, toId, relationship);
    emit("directory", "directory.relationship.added", { fromId, toId, relationship });
    return c.json({ added: true, fromId, toId, relationship }, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// DELETE /directory/relationships — Remove a relationship edge
directoryRoutes.delete("/relationships", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { fromId, toId } = body;
  if (!fromId || !toId) {
    return c.json({ error: "fromId and toId are required" }, 400);
  }
  directoryStore.removeRelationship(fromId, toId);
  return c.json({ deleted: true });
});
