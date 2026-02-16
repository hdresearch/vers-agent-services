import { Hono } from "hono";
import {
  ProjectStore,
  ValidationError,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "./store.js";
import { ProjectAggregator } from "./aggregator.js";

export const projectStore = new ProjectStore();
export const projectRoutes = new Hono();

// ── Helper: resolve aggregator deps from env/headers ───────────────────

function getAggregatorDeps(c: any): { baseUrl: string; authToken: string } {
  // In monolith mode, the server is itself — use localhost
  const port = process.env.PORT || "3000";
  const baseUrl =
    process.env.VERS_INFRA_URL || `http://localhost:${port}`;
  const authToken = process.env.VERS_AUTH_TOKEN || "";
  return { baseUrl, authToken };
}

// ── POST /projects — Create a project ──────────────────────────────────

projectRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const input: CreateProjectInput = {
      name: body.name,
      displayName: body.displayName,
      description: body.description,
      status: body.status,
      tags: body.tags,
      matchers: body.matchers,
    };
    const project = projectStore.create(input);
    return c.json(project, 201);
  } catch (e: any) {
    if (e instanceof ValidationError) {
      return c.json({ error: e.message }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── GET /projects — List all projects ──────────────────────────────────

projectRoutes.get("/", async (c) => {
  const status = c.req.query("status") as any;
  const tag = c.req.query("tag");
  const projects = projectStore.list({ status, tag });
  return c.json({ projects, count: projects.length });
});

// ── GET /projects/:id — Get a single project ──────────────────────────

projectRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");

  // Support lookup by name as well
  let project = projectStore.get(id);
  if (!project) {
    project = projectStore.getByName(id);
  }
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }
  return c.json(project);
});

// ── PATCH /projects/:id — Update a project ─────────────────────────────

projectRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    const input: UpdateProjectInput = {};
    if (body.name !== undefined) input.name = body.name;
    if (body.displayName !== undefined) input.displayName = body.displayName;
    if (body.description !== undefined) input.description = body.description;
    if (body.status !== undefined) input.status = body.status;
    if (body.tags !== undefined) input.tags = body.tags;
    if (body.matchers !== undefined) input.matchers = body.matchers;

    const project = projectStore.update(id, input);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(project);
  } catch (e: any) {
    if (e instanceof ValidationError) {
      return c.json({ error: e.message }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── DELETE /projects/:id — Delete a project ────────────────────────────

projectRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = projectStore.delete(id);
  if (!deleted) {
    return c.json({ error: "Project not found" }, 404);
  }
  return c.json({ deleted: true });
});

// ── GET /projects/:id/view — THE BIG ONE: unified project view ─────────

projectRoutes.get("/:id/view", async (c) => {
  const id = c.req.param("id");

  // Support lookup by name
  let project = projectStore.get(id);
  if (!project) {
    project = projectStore.getByName(id);
  }
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const deps = getAggregatorDeps(c);
  const aggregator = new ProjectAggregator(deps);

  try {
    const view = await aggregator.buildView(project);
    return c.json(view);
  } catch (e: any) {
    return c.json(
      {
        error: "Failed to build project view",
        detail: e.message,
      },
      500,
    );
  }
});
