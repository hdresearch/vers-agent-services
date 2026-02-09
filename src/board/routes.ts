import { Hono } from "hono";
import {
  BoardStore,
  NotFoundError,
  ValidationError,
  type TaskFilters,
  type TaskStatus,
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
