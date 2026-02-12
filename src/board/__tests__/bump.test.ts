import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardStore, NotFoundError } from "../store.js";

// --- Store unit tests ---

describe("BoardStore — bump", () => {
  let store: BoardStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bump-test-"));
    filePath = join(tmpDir, "board.json");
    store = new BoardStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bumps score from 0 to 1", () => {
    const task = store.createTask({ title: "Bump me", createdBy: "agent-1" });
    expect(task.score).toBe(0);

    const bumped = store.bumpTask(task.id);
    expect(bumped.score).toBe(1);
  });

  it("multiple bumps accumulate", () => {
    const task = store.createTask({ title: "Popular", createdBy: "agent-1" });

    store.bumpTask(task.id);
    store.bumpTask(task.id);
    const bumped = store.bumpTask(task.id);

    expect(bumped.score).toBe(3);
  });

  it("bump persists across store reload", () => {
    const task = store.createTask({ title: "Persistent bump", createdBy: "agent-1" });
    store.bumpTask(task.id);
    store.bumpTask(task.id);
    store.flush();

    const store2 = new BoardStore(filePath);
    const loaded = store2.getTask(task.id);
    expect(loaded).toBeDefined();
    expect(loaded!.score).toBe(2);
  });

  it("throws NotFoundError for nonexistent task", () => {
    expect(() => store.bumpTask("nonexistent")).toThrow(NotFoundError);
  });

  it("score defaults to 0 for existing tasks without score field", () => {
    // Write a task without the score field to simulate old data
    const oldTask = {
      id: "OLD01",
      title: "Legacy task",
      status: "open",
      tags: [],
      dependencies: [],
      createdBy: "agent-0",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      notes: [],
      // no score field
    };
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ tasks: [oldTask] }));

    const store2 = new BoardStore(filePath);
    const loaded = store2.getTask("OLD01");
    expect(loaded).toBeDefined();
    expect(loaded!.score).toBe(0);

    // And bumping it should work
    const bumped = store2.bumpTask("OLD01");
    expect(bumped.score).toBe(1);
  });
});

// --- Route integration tests ---

describe("Board Routes — bump", () => {
  let app: Hono;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "bump-route-test-"));

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

  it("POST /board/tasks/:id/bump — increments score", async () => {
    const createRes = await app.request("/board/tasks", json({ title: "Bump via API", createdBy: "a" }));
    const created = await createRes.json();

    const res = await app.request(`/board/tasks/${created.id}/bump`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBe(1);

    // Bump again
    const res2 = await app.request(`/board/tasks/${created.id}/bump`, { method: "POST" });
    const body2 = await res2.json();
    expect(body2.score).toBe(2);
  });

  it("POST /board/tasks/:id/bump — 404 for unknown task", async () => {
    const res = await app.request("/board/tasks/nonexistent/bump", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
