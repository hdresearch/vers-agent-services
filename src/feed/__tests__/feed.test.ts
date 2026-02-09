import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { FeedStore } from "../store.js";
import { feedRoutes, feedStore } from "../routes.js";
import { unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";

// Helper to make requests against the feed routes
const app = new Hono();
app.route("/feed", feedRoutes);

function req(path: string, init?: RequestInit) {
  return app.request(`http://localhost/feed${path}`, init);
}

function publishEvent(overrides: Record<string, unknown> = {}) {
  const body = {
    agent: "test-agent",
    type: "task_started",
    summary: "Starting test task",
    ...overrides,
  };
  return req("/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Feed Service", () => {
  beforeEach(async () => {
    // Clear events before each test
    await req("/events", { method: "DELETE" });
  });

  describe("POST /events — Publish", () => {
    it("publishes a valid event and returns 201", async () => {
      const res = await publishEvent();
      expect(res.status).toBe(201);
      const event = await res.json();
      expect(event.id).toBeDefined();
      expect(event.agent).toBe("test-agent");
      expect(event.type).toBe("task_started");
      expect(event.summary).toBe("Starting test task");
      expect(event.timestamp).toBeDefined();
    });

    it("publishes event with detail and metadata", async () => {
      const res = await publishEvent({
        detail: "Some details here",
        metadata: { cost: 0.05, tokens: 1000 },
      });
      expect(res.status).toBe(201);
      const event = await res.json();
      expect(event.detail).toBe("Some details here");
      expect(event.metadata).toEqual({ cost: 0.05, tokens: 1000 });
    });

    it("rejects event with missing agent", async () => {
      const res = await req("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_started", summary: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects event with invalid type", async () => {
      const res = await publishEvent({ type: "invalid_type" });
      expect(res.status).toBe(400);
    });

    it("rejects event with missing summary", async () => {
      const res = await req("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "a", type: "task_started" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-JSON body", async () => {
      const res = await req("/events", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /events — List", () => {
    it("returns empty array when no events", async () => {
      const res = await req("/events");
      expect(res.status).toBe(200);
      const events = await res.json();
      expect(events).toEqual([]);
    });

    it("returns published events", async () => {
      await publishEvent({ agent: "a1", summary: "first" });
      await publishEvent({ agent: "a2", summary: "second" });
      const res = await req("/events");
      const events = await res.json();
      expect(events).toHaveLength(2);
    });

    it("filters by agent", async () => {
      await publishEvent({ agent: "a1" });
      await publishEvent({ agent: "a2" });
      await publishEvent({ agent: "a1" });
      const res = await req("/events?agent=a1");
      const events = await res.json();
      expect(events).toHaveLength(2);
      expect(events.every((e: any) => e.agent === "a1")).toBe(true);
    });

    it("filters by type", async () => {
      await publishEvent({ type: "task_started" });
      await publishEvent({ type: "task_completed" });
      await publishEvent({ type: "task_started" });
      const res = await req("/events?type=task_started");
      const events = await res.json();
      expect(events).toHaveLength(2);
      expect(events.every((e: any) => e.type === "task_started")).toBe(true);
    });

    it("filters by since (ISO timestamp)", async () => {
      await publishEvent({ summary: "old" });
      const cutoff = new Date().toISOString();
      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));
      await publishEvent({ summary: "new" });
      const res = await req(`/events?since=${cutoff}`);
      const events = await res.json();
      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe("new");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await publishEvent({ summary: `event-${i}` });
      }
      const res = await req("/events?limit=3");
      const events = await res.json();
      expect(events).toHaveLength(3);
      // Should return last 3
      expect(events[2].summary).toBe("event-9");
    });
  });

  describe("GET /events/:id — Single event", () => {
    it("returns a specific event by ID", async () => {
      const pubRes = await publishEvent({ summary: "find me" });
      const published = await pubRes.json();
      const res = await req(`/events/${published.id}`);
      expect(res.status).toBe(200);
      const event = await res.json();
      expect(event.id).toBe(published.id);
      expect(event.summary).toBe("find me");
    });

    it("returns 404 for non-existent event", async () => {
      const res = await req("/events/01NONEXISTENT0000000000000");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /events — Clear", () => {
    it("clears all events", async () => {
      await publishEvent();
      await publishEvent();
      const delRes = await req("/events", { method: "DELETE" });
      expect(delRes.status).toBe(200);
      const listRes = await req("/events");
      const events = await listRes.json();
      expect(events).toEqual([]);
    });
  });

  describe("GET /stats — Statistics", () => {
    it("returns correct stats", async () => {
      await publishEvent({ agent: "a1", type: "task_started" });
      await publishEvent({ agent: "a1", type: "task_completed" });
      await publishEvent({ agent: "a2", type: "task_started" });

      const res = await req("/stats");
      expect(res.status).toBe(200);
      const stats = await res.json();
      expect(stats.total).toBe(3);
      expect(stats.byAgent).toEqual({ a1: 2, a2: 1 });
      expect(stats.byType).toEqual({ task_started: 2, task_completed: 1 });
      expect(stats.latestPerAgent.a1.type).toBe("task_completed");
      expect(stats.latestPerAgent.a2.type).toBe("task_started");
    });

    it("returns empty stats for empty feed", async () => {
      const res = await req("/stats");
      const stats = await res.json();
      expect(stats.total).toBe(0);
      expect(stats.byAgent).toEqual({});
      expect(stats.byType).toEqual({});
      expect(stats.latestPerAgent).toEqual({});
    });
  });

  describe("SSE /stream — Real-time streaming", () => {
    it("receives events published after connection", async () => {
      // Start SSE connection
      const res = await req("/stream");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Publish an event (directly through the store to avoid timing issues)
      const event = feedStore.publish({
        agent: "streamer",
        type: "finding",
        summary: "Found something",
      });

      // Read SSE response body
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      // Read chunks until we find our event (with timeout)
      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes(event.id)) break;
        }
      } finally {
        clearTimeout(timeout);
        reader.cancel();
      }

      expect(text).toContain(event.id);
      expect(text).toContain("Found something");
    });

    it("filters SSE stream by agent", async () => {
      const res = await req("/stream?agent=target");
      expect(res.status).toBe(200);

      // Publish events for different agents
      feedStore.publish({ agent: "other", type: "finding", summary: "ignore me" });
      const target = feedStore.publish({ agent: "target", type: "finding", summary: "want this" });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes(target.id)) break;
        }
      } finally {
        clearTimeout(timeout);
        reader.cancel();
      }

      expect(text).toContain("want this");
      expect(text).not.toContain("ignore me");
    });

    it("replays events since a ULID on reconnection", async () => {
      // Publish some events before connecting
      const e1 = feedStore.publish({ agent: "a", type: "finding", summary: "first" });
      const e2 = feedStore.publish({ agent: "a", type: "finding", summary: "second" });
      const e3 = feedStore.publish({ agent: "a", type: "finding", summary: "third" });

      // Connect with since=e1.id (should replay e2 and e3)
      const res = await req(`/stream?since=${e1.id}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      // Also publish a new event after connect to flush the stream
      setTimeout(() => {
        feedStore.publish({ agent: "a", type: "finding", summary: "fourth" });
      }, 100);

      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes("third")) break;
        }
      } finally {
        clearTimeout(timeout);
        reader.cancel();
      }

      expect(text).not.toContain('"first"');
      expect(text).toContain("second");
      expect(text).toContain("third");
    });
  });

  describe("FeedStore — Persistence", () => {
    const testFile = "data/test-feed.jsonl";

    afterEach(() => {
      if (existsSync(testFile)) unlinkSync(testFile);
    });

    it("persists events to JSONL and reloads on new instance", () => {
      const store1 = new FeedStore(testFile);
      store1.publish({ agent: "a1", type: "task_started", summary: "persisted event" });
      store1.publish({ agent: "a2", type: "finding", summary: "another one" });

      // Verify file exists and has content
      expect(existsSync(testFile)).toBe(true);
      const content = readFileSync(testFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);

      // Create new store from same file — should reload events
      const store2 = new FeedStore(testFile);
      expect(store2.size).toBe(2);
      const events = store2.list({ limit: 10 });
      expect(events[0].summary).toBe("persisted event");
      expect(events[1].summary).toBe("another one");
    });

    it("handles empty file gracefully", () => {
      mkdirSync("data", { recursive: true });
      const store = new FeedStore(testFile);
      expect(store.size).toBe(0);
    });

    it("respects maxInMemory limit", () => {
      const store = new FeedStore(testFile, 5);
      for (let i = 0; i < 10; i++) {
        store.publish({ agent: "a", type: "custom", summary: `event-${i}` });
      }
      expect(store.size).toBe(5);
      const events = store.list({ limit: 10 });
      expect(events[0].summary).toBe("event-5");
    });
  });

  describe("Edge cases", () => {
    it("all valid event types are accepted", async () => {
      const types = [
        "task_started", "task_completed", "task_failed", "blocker_found",
        "question", "finding", "skill_proposed", "file_changed",
        "cost_update", "agent_started", "agent_stopped", "custom",
      ];
      for (const type of types) {
        const res = await publishEvent({ type });
        expect(res.status).toBe(201);
      }
    });

    it("events have ULID ids that are sortable", async () => {
      const r1 = await publishEvent({ summary: "first" });
      const r2 = await publishEvent({ summary: "second" });
      const e1 = await r1.json();
      const e2 = await r2.json();
      expect(e1.id < e2.id).toBe(true);
    });
  });
});
