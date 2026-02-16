/**
 * Docs Registry routes — collaborative markdown document management.
 *
 * Authenticated routes (bearer auth applied in server.ts):
 *   POST   /docs                — create document
 *   GET    /docs                — list documents (filter by status, author, tag, search)
 *   GET    /docs/:id            — get document (latest version)
 *   PUT    /docs/:id            — update document (creates new version if content changed)
 *   DELETE /docs/:id            — delete document
 *   GET    /docs/:id/versions   — version history
 *   GET    /docs/:id/versions/:vid — specific version
 *   POST   /docs/:id/comments   — add comment
 *   GET    /docs/:id/comments   — list comments
 *   GET    /docs/:id/contributors — list contributors
 *   GET    /docs/search         — full-text search
 *
 * Public routes (no auth):
 *   GET    /docs/public         — list published documents
 *   GET    /docs/public/:id     — get a published document
 */

import { Hono } from "hono";
import { DocsStore } from "./store.js";
import type {
  CreateDocInput, UpdateDocInput, CreateCommentInput,
  DocStatus, DocFilters,
} from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";

// ── Store singleton ────────────────────────────────────────────────────────

export const docsStore = new DocsStore();

// ── Authenticated routes ───────────────────────────────────────────────────

export const docsRoutes = new Hono();

// GET /docs/search — full-text search (must be before /:id)
docsRoutes.get("/search", (c) => {
  const q = c.req.query("q") || "";
  if (!q.trim()) return c.json({ docs: [], count: 0 });
  const docs = docsStore.search(q);
  return c.json({ docs, count: docs.length });
});

// GET /docs — list documents
docsRoutes.get("/", (c) => {
  const filters: DocFilters = {};
  const status = c.req.query("status");
  if (status) filters.status = status as DocStatus;
  const author = c.req.query("author");
  if (author) filters.author = author;
  const tag = c.req.query("tag");
  if (tag) filters.tag = tag;
  const search = c.req.query("search");
  if (search) filters.search = search;

  let docs;
  if (filters.search) {
    docs = docsStore.search(filters.search);
    // Apply additional filters on search results
    if (filters.status) docs = docs.filter((d) => d.status === filters.status);
    if (filters.author) docs = docs.filter((d) => d.author === filters.author);
    if (filters.tag) docs = docs.filter((d) => d.tags.includes(filters.tag!));
  } else {
    docs = docsStore.list(filters);
  }
  return c.json({ docs, count: docs.length });
});

// POST /docs — create document
docsRoutes.post("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const doc = docsStore.create(body as CreateDocInput);
    return c.json(doc, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /docs/:id — get document
docsRoutes.get("/:id", (c) => {
  try {
    const doc = docsStore.get(c.req.param("id"));
    return c.json(doc);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// PUT /docs/:id — update document
docsRoutes.put("/:id", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const doc = docsStore.update(c.req.param("id"), body as UpdateDocInput);
    return c.json(doc);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// DELETE /docs/:id — delete document
docsRoutes.delete("/:id", (c) => {
  const deleted = docsStore.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "document not found" }, 404);
  return c.json({ deleted: true });
});

// GET /docs/:id/versions — version history
docsRoutes.get("/:id/versions", (c) => {
  try {
    const versions = docsStore.getVersions(c.req.param("id"));
    return c.json({ versions, count: versions.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /docs/:id/versions/:vid — specific version
docsRoutes.get("/:id/versions/:vid", (c) => {
  try {
    const version = docsStore.getVersion(c.req.param("id"), c.req.param("vid"));
    return c.json(version);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /docs/:id/comments — add comment
docsRoutes.post("/:id/comments", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const comment = docsStore.addComment(c.req.param("id"), body as CreateCommentInput);
    return c.json(comment, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /docs/:id/comments — list comments
docsRoutes.get("/:id/comments", (c) => {
  try {
    const comments = docsStore.getComments(c.req.param("id"));
    return c.json({ comments, count: comments.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /docs/:id/contributors — list contributors
docsRoutes.get("/:id/contributors", (c) => {
  try {
    const contributors = docsStore.getContributors(c.req.param("id"));
    return c.json({ contributors, count: contributors.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// ── Public routes (no auth) ────────────────────────────────────────────────

export const docsPublicRoutes = new Hono();

// GET /docs/public — list published documents
docsPublicRoutes.get("/public", (c) => {
  const tag = c.req.query("tag") || undefined;
  const search = c.req.query("search") || undefined;
  const docs = docsStore.listPublished({ tag, search });
  return c.json({ docs, count: docs.length });
});

// GET /docs/public/:id — get a published document
docsPublicRoutes.get("/public/:id", (c) => {
  try {
    const doc = docsStore.getPublished(c.req.param("id"));
    return c.json(doc);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});
