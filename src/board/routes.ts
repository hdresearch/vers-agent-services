import { Hono } from "hono";
import {
  BoardStore,
  NotFoundError,
  ValidationError,
  type TaskFilters,
  type TaskStatus,
  type AddArtifactInput,
} from "./store.js";

const store = new BoardStore();

export const boardRoutes = new Hono();

// Create a task
boardRoutes.post("/tasks", async (c) => {
  try {
    const body = await c.req.json();
    const task = store.createTask(body);
    return c.json(task, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// List tasks with optional filters
boardRoutes.get("/tasks", (c) => {
  const filters: TaskFilters = {};
  const status = c.req.query("status");
  const assignee = c.req.query("assignee");
  const tag = c.req.query("tag");

  if (status) filters.status = status as TaskStatus;
  if (assignee) filters.assignee = assignee;
  if (tag) filters.tag = tag;

  const tasks = store.listTasks(filters);
  return c.json({ tasks, count: tasks.length });
});

// Get a single task
boardRoutes.get("/tasks/:id", (c) => {
  const task = store.getTask(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json(task);
});

// List tasks in review
boardRoutes.get("/review", (c) => {
  const tasks = store.listTasks({ status: "in_review" });
  // Sort by updatedAt desc (newest first)
  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json({ tasks, count: tasks.length });
});

// Add artifact(s) to a task
boardRoutes.post("/tasks/:id/artifacts", async (c) => {
  try {
    const body = await c.req.json();
    const artifacts = store.addArtifacts(c.req.param("id"), body.artifacts);
    const task = store.getTask(c.req.param("id"));
    return c.json(task, 201);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Submit a task for review
boardRoutes.post("/tasks/:id/review", async (c) => {
  try {
    const body = await c.req.json();
    const id = c.req.param("id");

    if (!body.summary?.trim()) {
      return c.json({ error: "summary is required" }, 400);
    }

    // Set status to in_review
    store.updateTask(id, { status: "in_review" });

    // Add summary note
    const author = body.reviewedBy?.trim() || "unknown";
    store.addNote(id, {
      author,
      content: body.summary.trim(),
      type: "update",
    });

    // Attach artifacts if provided
    if (body.artifacts && Array.isArray(body.artifacts) && body.artifacts.length > 0) {
      const artifactsWithAuthor = body.artifacts.map((a: AddArtifactInput) => ({
        ...a,
        addedBy: a.addedBy || author,
      }));
      store.addArtifacts(id, artifactsWithAuthor);
    }

    const task = store.getTask(id);
    return c.json(task);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Approve a reviewed task
boardRoutes.post("/tasks/:id/approve", async (c) => {
  try {
    const body = await c.req.json();
    const id = c.req.param("id");

    const approvedBy = body.approvedBy?.trim() || "unknown";
    const comment = body.comment?.trim() || "";

    // Set status to done
    store.updateTask(id, { status: "done" });

    // Add approval note
    const noteContent = comment
      ? `Approved by ${approvedBy}: ${comment}`
      : `Approved by ${approvedBy}`;
    store.addNote(id, {
      author: approvedBy,
      content: noteContent,
      type: "update",
    });

    const task = store.getTask(id);
    return c.json(task);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Reject a reviewed task
boardRoutes.post("/tasks/:id/reject", async (c) => {
  try {
    const body = await c.req.json();
    const id = c.req.param("id");

    if (!body.reason?.trim()) {
      return c.json({ error: "reason is required" }, 400);
    }

    const rejectedBy = body.rejectedBy?.trim() || "unknown";

    // Set status to open
    store.updateTask(id, { status: "open" });

    // Add rejection note
    store.addNote(id, {
      author: rejectedBy,
      content: `Rejected by ${rejectedBy}: ${body.reason.trim()}`,
      type: "update",
    });

    const task = store.getTask(id);
    return c.json(task);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Get a single task (convenience alias — /board/:id)
boardRoutes.get("/:id", (c) => {
  const task = store.getTask(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json(task);
});

// Update a task
boardRoutes.patch("/tasks/:id", async (c) => {
  try {
    const body = await c.req.json();
    const task = store.updateTask(c.req.param("id"), body);
    return c.json(task);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Delete a task
boardRoutes.delete("/tasks/:id", (c) => {
  const deleted = store.deleteTask(c.req.param("id"));
  if (!deleted) return c.json({ error: "task not found" }, 404);
  return c.json({ deleted: true });
});

// Bump a task's score
boardRoutes.post("/tasks/:id/bump", (c) => {
  try {
    const task = store.bumpTask(c.req.param("id"));
    return c.json(task);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// Add a note to a task
boardRoutes.post("/tasks/:id/notes", async (c) => {
  try {
    const body = await c.req.json();
    const note = store.addNote(c.req.param("id"), body);
    return c.json(note, 201);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Get notes for a task
boardRoutes.get("/tasks/:id/notes", (c) => {
  try {
    const notes = store.getNotes(c.req.param("id"));
    return c.json({ notes, count: notes.length });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});
