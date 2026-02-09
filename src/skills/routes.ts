import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  SkillStore,
  ExtensionStore,
  ManifestStore,
  NotFoundError,
  ValidationError,
} from "./store.js";
import type { ChangeEvent } from "./store.js";

export const skillStore = new SkillStore();
export const extensionStore = new ExtensionStore();
export const manifestStore = new ManifestStore();

export const skillsRoutes = new Hono();

// ─── Skills CRUD ─────────────────────────────────────────────

// POST /items — Publish or update a skill (upsert by name)
skillsRoutes.post("/items", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const skill = skillStore.publish(body as any);
    return c.json(skill, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /items — List all skills
skillsRoutes.get("/items", (c) => {
  const tag = c.req.query("tag");
  const enabledStr = c.req.query("enabled");
  const enabled = enabledStr !== undefined ? enabledStr === "true" : undefined;

  const skills = skillStore.list({ tag, enabled });
  return c.json({ skills, count: skills.length });
});

// GET /items/:name — Get a skill by name
skillsRoutes.get("/items/:name", (c) => {
  const skill = skillStore.get(c.req.param("name"));
  if (!skill) return c.json({ error: "skill not found" }, 404);
  return c.json(skill);
});

// PATCH /items/:name — Update metadata
skillsRoutes.patch("/items/:name", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const skill = skillStore.patch(c.req.param("name"), body as any);
    return c.json(skill);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// DELETE /items/:name — Remove a skill
skillsRoutes.delete("/items/:name", (c) => {
  const deleted = skillStore.delete(c.req.param("name"));
  if (!deleted) return c.json({ error: "skill not found" }, 404);
  return c.json({ deleted: true });
});

// ─── Extensions CRUD ─────────────────────────────────────────

// POST /extensions — Publish or update an extension
skillsRoutes.post("/extensions", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const ext = extensionStore.publish(body as any);
    return c.json(ext, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /extensions — List all extensions
skillsRoutes.get("/extensions", (c) => {
  const extensions = extensionStore.list();
  return c.json({ extensions, count: extensions.length });
});

// GET /extensions/:name — Get an extension by name
skillsRoutes.get("/extensions/:name", (c) => {
  const ext = extensionStore.get(c.req.param("name"));
  if (!ext) return c.json({ error: "extension not found" }, 404);
  return c.json(ext);
});

// DELETE /extensions/:name — Remove an extension
skillsRoutes.delete("/extensions/:name", (c) => {
  const deleted = extensionStore.delete(c.req.param("name"));
  if (!deleted) return c.json({ error: "extension not found" }, 404);
  return c.json({ deleted: true });
});

// ─── Sync Protocol ───────────────────────────────────────────

// GET /manifest — Current manifest of all enabled skills + extensions
skillsRoutes.get("/manifest", (c) => {
  const skills = skillStore.manifest();
  const extensions = extensionStore.manifest();
  return c.json({ skills, extensions });
});

// POST /sync — Agent reports installed state, gets back needed updates
skillsRoutes.post("/sync", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const currentSkills = skillStore.manifest();
    const currentExtensions = extensionStore.manifest();
    const updates = manifestStore.sync(body as any, currentSkills, currentExtensions);
    return c.json({ updates });
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /stream — SSE stream of skill/extension changes
skillsRoutes.get("/stream", (c) => {
  const sinceId = c.req.query("since");

  return streamSSE(c, async (stream) => {
    // Replay events since a ULID if provided
    if (sinceId) {
      const missedSkills = skillStore.eventsSince(sinceId);
      const missedExtensions = extensionStore.eventsSince(sinceId);
      const all = [...missedSkills, ...missedExtensions].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      for (const event of all) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    }

    // Subscribe to new events from both stores
    const unsubSkills = skillStore.subscribe((event: ChangeEvent) => {
      stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    });
    const unsubExtensions = extensionStore.subscribe((event: ChangeEvent) => {
      stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    });

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      stream.write(": heartbeat\n\n").catch(() => {});
    }, 15000);

    // Cleanup on disconnect
    stream.onAbort(() => {
      unsubSkills();
      unsubExtensions();
      clearInterval(heartbeat);
    });

    // Keep alive
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    unsubSkills();
    unsubExtensions();
    clearInterval(heartbeat);
  });
});

// ─── Agent Inventory ─────────────────────────────────────────

// GET /agents — List all agents and their manifests
skillsRoutes.get("/agents", (c) => {
  const agents = manifestStore.list();
  return c.json({ agents, count: agents.length });
});

// GET /agents/:agentId — Get a specific agent's manifest
skillsRoutes.get("/agents/:agentId", (c) => {
  const manifest = manifestStore.get(c.req.param("agentId"));
  if (!manifest) return c.json({ error: "agent not found" }, 404);
  return c.json(manifest);
});
