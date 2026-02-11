import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardStore, NotFoundError, ValidationError } from "../store.js";

// --- Store unit tests for artifacts ---

describe("BoardStore — Artifacts", () => {
  let store: BoardStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "board-review-test-"));
    store = new BoardStore(join(tmpDir, "board.json"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("new tasks have empty artifacts array", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    expect(task.artifacts).toEqual([]);
  });

  it("adds artifacts to a task", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    const added = store.addArtifacts(task.id, [
      { type: "branch", url: "https://github.com/org/repo/tree/feat", label: "Feature branch" },
      { type: "url", url: "https://example.com", label: "Docs", addedBy: "agent-1" },
    ]);
    expect(added).toHaveLength(2);
    expect(added[0].type).toBe("branch");
    expect(added[0].addedAt).toBeTruthy();
    expect(added[1].addedBy).toBe("agent-1");

    const updated = store.getTask(task.id)!;
    expect(updated.artifacts).toHaveLength(2);
  });

  it("accumulates artifacts across multiple calls", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    store.addArtifacts(task.id, [{ type: "branch", url: "u1", label: "L1" }]);
    store.addArtifacts(task.id, [{ type: "report", url: "u2", label: "L2" }]);
    expect(store.getTask(task.id)!.artifacts).toHaveLength(2);
  });

  it("validates artifact type", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    expect(() =>
      store.addArtifacts(task.id, [{ type: "bad" as any, url: "u", label: "l" }])
    ).toThrow(ValidationError);
  });

  it("validates artifact url", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    expect(() =>
      store.addArtifacts(task.id, [{ type: "url", url: "", label: "l" }])
    ).toThrow(ValidationError);
  });

  it("validates artifact label", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    expect(() =>
      store.addArtifacts(task.id, [{ type: "url", url: "u", label: "" }])
    ).toThrow(ValidationError);
  });

  it("throws NotFoundError for unknown task", () => {
    expect(() =>
      store.addArtifacts("nope", [{ type: "url", url: "u", label: "l" }])
    ).toThrow(NotFoundError);
  });

  it("rejects empty artifacts array", () => {
    const task = store.createTask({ title: "T1", createdBy: "a" });
    expect(() => store.addArtifacts(task.id, [])).toThrow(ValidationError);
  });

  it("persists artifacts to disk and reloads", () => {
    const filePath = join(tmpDir, "persist.json");
    const s1 = new BoardStore(filePath);
    const task = s1.createTask({ title: "T1", createdBy: "a" });
    s1.addArtifacts(task.id, [{ type: "branch", url: "u1", label: "Branch" }]);
    s1.flush();

    const s2 = new BoardStore(filePath);
    const loaded = s2.getTask(task.id)!;
    expect(loaded.artifacts).toHaveLength(1);
    expect(loaded.artifacts[0].type).toBe("branch");
  });

  it("backward compat — old tasks without artifacts get default", () => {
    const filePath = join(tmpDir, "compat.json");
    // Write old-style data without artifacts field
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      tasks: [{
        id: "old-task",
        title: "Old",
        status: "open",
        tags: [],
        dependencies: [],
        createdBy: "a",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        notes: [],
      }],
    }));

    const s = new BoardStore(filePath);
    const task = s.getTask("old-task")!;
    expect(task.artifacts).toEqual([]);
  });
});

// --- Route integration tests for review flow ---

describe("Review Queue Routes", () => {
  let app: Hono;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "review-route-test-"));
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

  async function createTask(title = "Test Task") {
    const res = await app.request("/board/tasks", json({ title, createdBy: "agent-1" }));
    return res.json();
  }

  it("POST /board/tasks/:id/artifacts — adds artifacts", async () => {
    const task = await createTask();
    const res = await app.request(
      `/board/tasks/${task.id}/artifacts`,
      json({ artifacts: [{ type: "branch", url: "https://github.com/x", label: "Branch" }] })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].type).toBe("branch");
  });

  it("POST /board/tasks/:id/artifacts — 404 for unknown task", async () => {
    const res = await app.request(
      "/board/tasks/nonexistent/artifacts",
      json({ artifacts: [{ type: "url", url: "u", label: "l" }] })
    );
    expect(res.status).toBe(404);
  });

  it("POST /board/tasks/:id/artifacts — 400 for invalid artifact", async () => {
    const task = await createTask();
    const res = await app.request(
      `/board/tasks/${task.id}/artifacts`,
      json({ artifacts: [{ type: "bad", url: "u", label: "l" }] })
    );
    expect(res.status).toBe(400);
  });

  it("POST /board/tasks/:id/review — submits for review", async () => {
    const task = await createTask();
    const res = await app.request(
      `/board/tasks/${task.id}/review`,
      json({
        summary: "Implemented feature X",
        reviewedBy: "agent-1",
        artifacts: [{ type: "branch", url: "https://github.com/x", label: "PR" }],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("in_review");
    expect(body.artifacts).toHaveLength(1);
    expect(body.notes.length).toBeGreaterThanOrEqual(1);
    const lastNote = body.notes[body.notes.length - 1];
    expect(lastNote.content).toBe("Implemented feature X");
    expect(lastNote.author).toBe("agent-1");
  });

  it("POST /board/tasks/:id/review — 400 without summary", async () => {
    const task = await createTask();
    const res = await app.request(
      `/board/tasks/${task.id}/review`,
      json({ reviewedBy: "a" })
    );
    expect(res.status).toBe(400);
  });

  it("POST /board/tasks/:id/approve — approves a task", async () => {
    const task = await createTask();
    // First submit for review
    await app.request(
      `/board/tasks/${task.id}/review`,
      json({ summary: "Done", reviewedBy: "agent-1" })
    );
    // Then approve
    const res = await app.request(
      `/board/tasks/${task.id}/approve`,
      json({ comment: "Looks good", approvedBy: "reviewer" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    const lastNote = body.notes[body.notes.length - 1];
    expect(lastNote.content).toBe("Approved by reviewer: Looks good");
  });

  it("POST /board/tasks/:id/approve — works without comment", async () => {
    const task = await createTask();
    await app.request(
      `/board/tasks/${task.id}/review`,
      json({ summary: "Done", reviewedBy: "agent-1" })
    );
    const res = await app.request(
      `/board/tasks/${task.id}/approve`,
      json({ approvedBy: "reviewer" })
    );
    const body = await res.json();
    expect(body.status).toBe("done");
    const lastNote = body.notes[body.notes.length - 1];
    expect(lastNote.content).toBe("Approved by reviewer");
  });

  it("POST /board/tasks/:id/reject — rejects a task", async () => {
    const task = await createTask();
    await app.request(
      `/board/tasks/${task.id}/review`,
      json({ summary: "Done", reviewedBy: "agent-1" })
    );
    const res = await app.request(
      `/board/tasks/${task.id}/reject`,
      json({ reason: "Needs more tests", rejectedBy: "reviewer" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("open");
    const lastNote = body.notes[body.notes.length - 1];
    expect(lastNote.content).toBe("Rejected by reviewer: Needs more tests");
  });

  it("POST /board/tasks/:id/reject — 400 without reason", async () => {
    const task = await createTask();
    const res = await app.request(
      `/board/tasks/${task.id}/reject`,
      json({ rejectedBy: "reviewer" })
    );
    expect(res.status).toBe(400);
  });

  it("GET /board/review — only returns in_review tasks", async () => {
    const t1 = await createTask("Open task");
    const t2 = await createTask("Review task 1");
    const t3 = await createTask("Review task 2");
    const t4 = await createTask("Done task");

    // Submit t2 and t3 for review
    await app.request(
      `/board/tasks/${t2.id}/review`,
      json({ summary: "Ready for review", reviewedBy: "agent-1" })
    );
    await app.request(
      `/board/tasks/${t3.id}/review`,
      json({ summary: "Also ready", reviewedBy: "agent-2" })
    );
    // Mark t4 as done
    await app.request(`/board/tasks/${t4.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    const res = await app.request("/board/review");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Module-level store is shared, so filter to our tasks
    const ourIds = new Set([t1.id, t2.id, t3.id, t4.id]);
    const ourTasks = body.tasks.filter((t: any) => ourIds.has(t.id));
    expect(ourTasks).toHaveLength(2);
    expect(ourTasks.every((t: any) => t.status === "in_review")).toBe(true);
    expect(body.tasks.every((t: any) => t.status === "in_review")).toBe(true);
    // Newest first by updatedAt — check overall ordering
    for (let i = 1; i < body.tasks.length; i++) {
      expect(new Date(body.tasks[i - 1].updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(body.tasks[i].updatedAt).getTime()
      );
    }
  });

  it("GET /board/review — returns tasks with artifacts and notes", async () => {
    const task = await createTask("With artifacts");
    await app.request(
      `/board/tasks/${task.id}/review`,
      json({
        summary: "Feature complete",
        reviewedBy: "agent-1",
        artifacts: [{ type: "branch", url: "https://github.com/x", label: "PR #42" }],
      })
    );

    const res = await app.request("/board/review");
    const body = await res.json();
    expect(body.tasks[0].artifacts).toHaveLength(1);
    expect(body.tasks[0].notes.length).toBeGreaterThanOrEqual(1);
  });

  it("full flow: create → review → approve", async () => {
    const task = await createTask("Full flow");

    // Submit for review with artifacts
    await app.request(
      `/board/tasks/${task.id}/review`,
      json({
        summary: "Implemented the thing",
        reviewedBy: "agent-1",
        artifacts: [
          { type: "branch", url: "https://github.com/repo/tree/feat", label: "Feature branch" },
          { type: "report", url: "report-123", label: "Test report" },
        ],
      })
    );

    // Verify it shows in review queue
    let reviewRes = await app.request("/board/review");
    let reviewBody = await reviewRes.json();
    expect(reviewBody.count).toBeGreaterThanOrEqual(1);

    // Approve it
    await app.request(
      `/board/tasks/${task.id}/approve`,
      json({ comment: "Ship it!", approvedBy: "noah" })
    );

    // Should no longer be in review queue
    reviewRes = await app.request("/board/review");
    reviewBody = await reviewRes.json();
    const found = reviewBody.tasks.find((t: any) => t.id === task.id);
    expect(found).toBeUndefined();

    // Should be done
    const taskRes = await app.request(`/board/tasks/${task.id}`);
    const taskBody = await taskRes.json();
    expect(taskBody.status).toBe("done");
    expect(taskBody.artifacts).toHaveLength(2);
  });

  it("full flow: create → review → reject → back to open", async () => {
    const task = await createTask("Reject flow");

    await app.request(
      `/board/tasks/${task.id}/review`,
      json({ summary: "WIP", reviewedBy: "agent-1" })
    );

    await app.request(
      `/board/tasks/${task.id}/reject`,
      json({ reason: "Incomplete", rejectedBy: "noah" })
    );

    const taskRes = await app.request(`/board/tasks/${task.id}`);
    const taskBody = await taskRes.json();
    expect(taskBody.status).toBe("open");
    // Should have 2 notes: review summary + rejection
    expect(taskBody.notes.length).toBeGreaterThanOrEqual(2);
  });
});
