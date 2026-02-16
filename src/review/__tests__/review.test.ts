import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { reviewRoutes } from "../routes.js";
import { BoardStore } from "../../board/store.js";

// Use a temp file so tests don't collide
const TEST_FILE = `data/test-review-${Date.now()}.json`;
const store = new BoardStore(TEST_FILE);

// We need to create tasks in the store that the review routes also use.
// The review routes instantiate their own store with default path.
// For integration testing, we'll test via the HTTP layer using the app.

import { app } from "../../server.js";

const AUTH_TOKEN = process.env.VERS_AUTH_TOKEN || "test-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AUTH_TOKEN}`,
};

async function createTask(title: string): Promise<string> {
  const res = await app.request("/board/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title, createdBy: "test-agent" }),
  });
  const data = await res.json() as any;
  return data.id;
}

describe("Review Routes", () => {
  describe("POST /review/submit", () => {
    it("requires taskId and summary", async () => {
      const res = await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("submits a task for review with full structure", async () => {
      const taskId = await createTask("Build login page");

      const res = await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskId,
          summary: "Implemented OAuth2 login flow with Google provider.",
          submittedBy: "worker-1",
          branch: "feat/login",
          testResults: { passed: 12, failed: 0, skipped: 1 },
          concerns: "Didn't test Safari",
          artifacts: [
            { type: "deploy", url: "https://preview.example.com", label: "Preview" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const task = await res.json() as any;
      expect(task.status).toBe("in_review");
      expect(task.artifacts.length).toBeGreaterThanOrEqual(2); // branch + deploy
      expect(task.notes.length).toBe(1);
      expect(task.notes[0].content).toContain("OAuth2");
      expect(task.notes[0].content).toContain("[TEST PASS]");
      expect(task.notes[0].content).toContain("Concerns");
    });
  });

  describe("GET /review/queue", () => {
    it("returns enriched review tasks", async () => {
      const taskId = await createTask("Review queue test");

      await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskId,
          summary: "Did the thing",
          submittedBy: "worker-2",
          testResults: { passed: 5, failed: 2, skipped: 0 },
        }),
      });

      const res = await app.request("/review/queue", { headers });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.count).toBeGreaterThanOrEqual(1);

      const found = data.tasks.find((t: any) => t.id === taskId);
      expect(found).toBeDefined();
      expect(found.testResults.status).toBe("FAIL");
      expect(found.testResults.failed).toBe(2);
      expect(found.submittedBy).toBe("worker-2");
    });
  });

  describe("POST /review/:taskId/approve", () => {
    it("moves task to done", async () => {
      const taskId = await createTask("Approve test");
      await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, summary: "Ready to go", submittedBy: "w" }),
      });

      const res = await app.request(`/review/${taskId}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "LGTM" }),
      });

      expect(res.status).toBe(200);
      const task = await res.json() as any;
      expect(task.status).toBe("done");
      expect(task.notes.some((n: any) => n.content.includes("✅"))).toBe(true);
    });
  });

  describe("POST /review/:taskId/reject", () => {
    it("requires a note", async () => {
      const taskId = await createTask("Reject test");
      await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, summary: "Try", submittedBy: "w" }),
      });

      const res = await app.request(`/review/${taskId}/reject`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("moves task to open with note", async () => {
      const taskId = await createTask("Reject test 2");
      await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, summary: "Try", submittedBy: "w" }),
      });

      const res = await app.request(`/review/${taskId}/reject`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "Missing tests" }),
      });

      expect(res.status).toBe(200);
      const task = await res.json() as any;
      expect(task.status).toBe("open");
      expect(task.notes.some((n: any) => n.content.includes("❌"))).toBe(true);
    });
  });

  describe("POST /review/:taskId/changes", () => {
    it("requires a note", async () => {
      const taskId = await createTask("Changes test");
      await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, summary: "V1", submittedBy: "w" }),
      });

      const res = await app.request(`/review/${taskId}/changes`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("moves task to in_progress with note", async () => {
      const taskId = await createTask("Changes test 2");
      await app.request("/review/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, summary: "V1", submittedBy: "w" }),
      });

      const res = await app.request(`/review/${taskId}/changes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "Add error handling" }),
      });

      expect(res.status).toBe(200);
      const task = await res.json() as any;
      expect(task.status).toBe("in_progress");
      expect(task.notes.some((n: any) => n.content.includes("🔄"))).toBe(true);
    });
  });
});
