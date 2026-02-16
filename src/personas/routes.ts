import { Hono } from "hono";
import {
  PersonaStore,
  NotFoundError,
  ValidationError,
  type PersonaFilters,
} from "./store.js";
import { emit } from "../events/emit.js";

export const store = new PersonaStore();

export const personaRoutes = new Hono();

// Create a persona
personaRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const persona = store.createPersona(body);
    emit("personas", "personas.created", { name: persona.name, author: persona.author, tags: persona.tags });
    return c.json(persona, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// List personas with optional filters
personaRoutes.get("/", (c) => {
  const filters: PersonaFilters = {};
  const tag = c.req.query("tag");
  const author = c.req.query("author");
  const specialization = c.req.query("specialization");
  const includeDeleted = c.req.query("include_deleted");

  if (tag) filters.tag = tag;
  if (author) filters.author = author;
  if (specialization) filters.specialization = specialization;
  if (includeDeleted === "true") filters.includeDeleted = true;

  const personas = store.listPersonas(filters);
  return c.json({ personas, count: personas.length });
});

// Get a single persona
personaRoutes.get("/:name", (c) => {
  const persona = store.getPersona(c.req.param("name"));
  if (!persona) return c.json({ error: "persona not found" }, 404);
  return c.json(persona);
});

// Update a persona (creates a new version)
personaRoutes.patch("/:name", async (c) => {
  try {
    const body = await c.req.json();
    const persona = store.updatePersona(c.req.param("name"), body);
    emit("personas", "personas.updated", { name: persona.name, version: persona.version });
    return c.json(persona);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Soft-delete a persona
personaRoutes.delete("/:name", (c) => {
  const deleted = store.deletePersona(c.req.param("name"));
  if (!deleted) return c.json({ error: "persona not found" }, 404);
  emit("personas", "personas.deleted", { name: c.req.param("name") });
  return c.json({ deleted: true });
});

// Get version history
personaRoutes.get("/:name/versions", (c) => {
  try {
    const versions = store.getVersions(c.req.param("name"));
    return c.json({ versions, count: versions.length });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// Render the full prompt with inheritance resolved
personaRoutes.get("/:name/prompt", (c) => {
  try {
    const result = store.renderPrompt(c.req.param("name"));
    return c.json(result);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});
