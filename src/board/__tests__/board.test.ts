import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BoardStore,
  NotFoundError,
  ValidationError,
} from "../store.js";

// --- Store unit tests ---

describe("BoardStore", () => {
  let store: BoardStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "board-test-"));
    filePath = join(tmpDir, "board.json");
    store = new BoardStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createTask", () => {
    it("creates a task with defaults", () => {
      const task = store.createTask({ title: "Fix bug", createdBy: "agent-1" });
      expect(task.id).toBeTruthy();
      expect(task.title).toBe("Fix bug");
      expect(task.status).toBe("open");
      expect(task.createdBy).toBe("agent-1");
      expect(task.tags).toEqual([]);
      expect(task.dependencies).toEqual([]);
      expect(task.notes).toEqual([]);
      expect(task.createdAt).toBeTruthy();
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it("creates a task with all fields", () => {
      const task = store.createTask({
        title: "Implement API",
        description: "Build the REST API",
        status: "in_progress",
        assignee: "agent-2",
        tags: ["backend", "urgent"],
        dependencies: ["dep-1"],
        createdBy: "agent-1",
      });
      expect(task.status).toBe("in_progress");
      expect(task.assignee).toBe("agent-2");
      expect(task.tags).toEqual(["backend", "urgent"]);
      expect(task.dependencies).toEqual(["dep-1"]);
      expect(task.description).toBe("Build the REST API");
    });

    it("rejects missing title", () => {
      expect(() => store.createTask({ title: "", createdBy: "agent-1" })).toThrow(ValidationError);
    });

    it("rejects missing createdBy", () => {
      expect(() => store.createTask({ title: "Test", createdBy: "" })).toThrow(ValidationError);
    });

    it("rejects invalid status", () => {
      expect(() =>
        store.createTask({ title: "Test", createdBy: "a", status: "invalid" as any })
      ).toThrow(ValidationError);
    });
  });

  describe("getTask", () => {
    it("returns a task by id", () => {
      const created = store.createTask({ title: "T1", createdBy: "a" });
      const found = store.getTask(created.id);
      expect(found).toEqual(created);
    });

    it("returns undefined for unknown id", () => {
      expect(store.getTask("nonexistent")).toBeUndefined();
    });
  });

  describe("listTasks", () => {
    beforeEach(() => {
      store.createTask({ title: "T1", createdBy: "a", status: "open", tags: ["backend"], assignee: "agent-1" });
      store.createTask({ title: "T2", createdBy: "b", status: "done", tags: ["frontend"], assignee: "agent-2" });
      store.createTask({ title: "T3", createdBy: "a", status: "open", tags: ["backend", "urgent"], assignee: "agent-1" });
    });

    it("lists all tasks", () => {
      expect(store.listTasks()).toHaveLength(3);
    });

    it("filters by status", () => {
      const open = store.listTasks({ status: "open" });
      expect(open).toHaveLength(2);
      expect(open.every((t) => t.status === "open")).toBe(true);
    });

    it("filters by assignee", () => {
      const tasks = store.listTasks({ assignee: "agent-2" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("T2");
    });

    it("filters by tag", () => {
      const tasks = store.listTasks({ tag: "backend" });
      expect(tasks).toHaveLength(2);
    });

    it("combines filters", () => {
      const tasks = store.listTasks({ status: "open", tag: "urgent" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("T3");
    });

    it("returns empty for no matches", () => {
      expect(store.listTasks({ status: "blocked" })).toHaveLength(0);
    });
  });

  describe("updateTask", () => {
    it("updates fields", async () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      // Ensure time difference
      await new Promise((r) => setTimeout(r, 5));
      const updated = store.updateTask(task.id, {
        status: "in_progress",
        assignee: "agent-3",
        tags: ["infra"],
      });
      expect(updated.status).toBe("in_progress");
      expect(updated.assignee).toBe("agent-3");
      expect(updated.tags).toEqual(["infra"]);
      expect(updated.updatedAt).not.toBe(task.createdAt);
    });

    it("clears assignee with null", () => {
      const task = store.createTask({ title: "T1", createdBy: "a", assignee: "agent-1" });
      const updated = store.updateTask(task.id, { assignee: null });
      expect(updated.assignee).toBeUndefined();
    });

    it("throws NotFoundError for unknown id", () => {
      expect(() => store.updateTask("nope", { status: "done" })).toThrow(NotFoundError);
    });

    it("rejects invalid status", () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      expect(() => store.updateTask(task.id, { status: "bad" as any })).toThrow(ValidationError);
    });

    it("rejects empty title", () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      expect(() => store.updateTask(task.id, { title: "" })).toThrow(ValidationError);
    });
  });

  describe("deleteTask", () => {
    it("deletes existing task", () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      expect(store.deleteTask(task.id)).toBe(true);
      expect(store.getTask(task.id)).toBeUndefined();
    });

    it("returns false for unknown id", () => {
      expect(store.deleteTask("nope")).toBe(false);
    });
  });

  describe("notes", () => {
    it("adds a note to a task", () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      const note = store.addNote(task.id, {
        author: "agent-1",
        content: "Found the bug",
        type: "finding",
      });
      expect(note.id).toBeTruthy();
      expect(note.author).toBe("agent-1");
      expect(note.content).toBe("Found the bug");
      expect(note.type).toBe("finding");
    });

    it("retrieves notes", () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      store.addNote(task.id, { author: "a1", content: "Note 1", type: "update" });
      store.addNote(task.id, { author: "a2", content: "Note 2", type: "blocker" });
      const notes = store.getNotes(task.id);
      expect(notes).toHaveLength(2);
    });

    it("throws NotFoundError for unknown task", () => {
      expect(() => store.addNote("nope", { author: "a", content: "c", type: "finding" })).toThrow(NotFoundError);
      expect(() => store.getNotes("nope")).toThrow(NotFoundError);
    });

    it("validates note input", () => {
      const task = store.createTask({ title: "T1", createdBy: "a" });
      expect(() => store.addNote(task.id, { author: "", content: "c", type: "finding" })).toThrow(ValidationError);
      expect(() => store.addNote(task.id, { author: "a", content: "", type: "finding" })).toThrow(ValidationError);
      expect(() => store.addNote(task.id, { author: "a", content: "c", type: "bad" as any })).toThrow(ValidationError);
    });
  });

  describe("persistence", () => {
    it("persists data to disk and reloads", () => {
      const task = store.createTask({ title: "Persistent", createdBy: "agent-1" });
      store.addNote(task.id, { author: "a1", content: "Note", type: "update" });
      store.flush(); // Force write

      // Create new store from same file
      const store2 = new BoardStore(filePath);
      const loaded = store2.getTask(task.id);
      expect(loaded).toBeDefined();
      expect(loaded!.title).toBe("Persistent");
      expect(loaded!.notes).toHaveLength(1);
      expect(loaded!.notes[0].content).toBe("Note");
    });

    it("writes valid JSON to disk", () => {
      store.createTask({ title: "T1", createdBy: "a" });
      store.flush();
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      expect(data.tasks).toHaveLength(1);
    });

    it("starts fresh if file is missing", () => {
      const freshStore = new BoardStore(join(tmpDir, "nonexistent.json"));
      expect(freshStore.listTasks()).toHaveLength(0);
    });
  });
});

// --- Route integration tests ---

describe("Board Routes", () => {
  let app: Hono;
  let store: BoardStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "board-route-test-"));
    const filePath = join(tmpDir, "board.json");
    store = new BoardStore(filePath);

    // We need to build a fresh Hono app that uses our test store.
    // Import routes dynamically isn't clean, so we'll test via the store + raw HTTP-like calls.
    // Actually, let's just build a mini app with the routes wired up using the store directly.
    // Since the routes module uses a module-level store, we'll test via app.request().

    // For integration tests, we import the real routes and test via Hono's test client
    const { boardRoutes } = await import("../routes.js");
    app = new Hono();
    app.route("/board", boardRoutes);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const json = (body: any) => ({
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("POST /board/tasks — creates a task", async () => {
    const res = await app.request("/board/tasks", json({ title: "Test", createdBy: "agent-1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Test");
    expect(body.id).toBeTruthy();
  });

  it("POST /board/tasks — 400 on missing title", async () => {
    const res = await app.request("/board/tasks", json({ createdBy: "agent-1" }));
    expect(res.status).toBe(400);
  });

  it("GET /board/tasks — lists tasks", async () => {
    await app.request("/board/tasks", json({ title: "T1", createdBy: "a" }));
    await app.request("/board/tasks", json({ title: "T2", createdBy: "b" }));
    const res = await app.request("/board/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it("GET /board/tasks?status=open — filters", async () => {
    await app.request("/board/tasks", json({ title: "T1", createdBy: "a", status: "open" }));
    await app.request("/board/tasks", json({ title: "T2", createdBy: "a", status: "done" }));
    const res = await app.request("/board/tasks?status=open");
    const body = await res.json();
    // At minimum our "open" task should be in results
    const openTasks = body.tasks.filter((t: any) => t.status === "open");
    expect(openTasks.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /board/tasks/:id — returns task", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "Find me", createdBy: "a" }));
    const created = await createRes.json();
    const res = await app.request(`/board/tasks/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Find me");
  });

  it("GET /board/tasks/:id — 404 for unknown", async () => {
    const res = await app.request("/board/tasks/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /board/:id — convenience alias returns task", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "Shortcut", createdBy: "a" }));
    const created = await createRes.json();
    const res = await app.request(`/board/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Shortcut");
    expect(body.id).toBe(created.id);
  });

  it("GET /board/:id — convenience alias 404 for unknown", async () => {
    const res = await app.request("/board/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PATCH /board/tasks/:id — updates task", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "T1", createdBy: "a" }));
    const created = await createRes.json();
    const res = await app.request(`/board/tasks/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", assignee: "agent-5" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(body.assignee).toBe("agent-5");
  });

  it("PATCH /board/tasks/:id — 404 for unknown", async () => {
    const res = await app.request("/board/tasks/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /board/tasks/:id — deletes task", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "T1", createdBy: "a" }));
    const created = await createRes.json();
    const res = await app.request(`/board/tasks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("DELETE /board/tasks/:id — 404 for unknown", async () => {
    const res = await app.request("/board/tasks/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /board/tasks/:id/notes — adds a note", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "T1", createdBy: "a" }));
    const created = await createRes.json();
    const res = await app.request(
      `/board/tasks/${created.id}/notes`,
      json({ author: "agent-1", content: "Found it", type: "finding" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.content).toBe("Found it");
  });

  it("GET /board/tasks/:id/notes — lists notes", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "T1", createdBy: "a" }));
    const created = await createRes.json();
    await app.request(`/board/tasks/${created.id}/notes`, json({ author: "a1", content: "N1", type: "update" }));
    await app.request(`/board/tasks/${created.id}/notes`, json({ author: "a2", content: "N2", type: "blocker" }));
    const res = await app.request(`/board/tasks/${created.id}/notes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it("POST /board/tasks/:id/notes — 404 for unknown task", async () => {
    const res = await app.request(
      "/board/tasks/nonexistent/notes",
      json({ author: "a", content: "c", type: "finding" })
    );
    expect(res.status).toBe(404);
  });

  it("GET /board/tasks/:id/notes — 404 for unknown task", async () => {
    const res = await app.request("/board/tasks/nonexistent/notes");
    expect(res.status).toBe(404);
  });
});
