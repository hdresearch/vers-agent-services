import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventLogStore } from "../store.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "data/test-events.db";

function cleanup() {
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

describe("EventLogStore", () => {
  let store: EventLogStore;

  beforeEach(() => {
    cleanup();
    store = new EventLogStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  describe("append", () => {
    it("appends an event and returns a record", () => {
      const record = store.append({
        source: "board",
        type: "board.task.created",
        payload: { taskId: "abc", title: "Test task" },
        agent: "lt-test",
      });

      expect(record.id).toBe(1);
      expect(record.eventId).toMatch(/^[0-9A-Z]{26}$/);
      expect(record.source).toBe("board");
      expect(record.type).toBe("board.task.created");
      expect(record.agent).toBe("lt-test");
      expect(record.payload).toEqual({ taskId: "abc", title: "Test task" });
      expect(record.timestamp).toBeTruthy();
    });

    it("validates required fields", () => {
      expect(() => store.append({ source: "", type: "x", payload: {} })).toThrow("source is required");
      expect(() => store.append({ source: "x", type: "", payload: {} })).toThrow("type is required");
      expect(() => store.append({ source: "x", type: "x", payload: undefined as any })).toThrow("payload is required");
    });

    it("handles null agent and metadata", () => {
      const record = store.append({ source: "test", type: "test.event", payload: { x: 1 } });
      expect(record.agent).toBeNull();
      expect(record.metadata).toBeNull();
    });

    it("stores metadata", () => {
      const record = store.append({
        source: "test",
        type: "test.event",
        payload: {},
        metadata: { correlationId: "abc-123", traceId: "xyz" },
      });
      expect(record.metadata).toEqual({ correlationId: "abc-123", traceId: "xyz" });
    });
  });

  describe("query", () => {
    beforeEach(() => {
      store.append({ source: "board", type: "board.task.created", payload: { id: 1 }, agent: "agent-a" });
      store.append({ source: "board", type: "board.task.updated", payload: { id: 2 }, agent: "agent-b" });
      store.append({ source: "feed", type: "feed.event.published", payload: { id: 3 }, agent: "agent-a" });
      store.append({ source: "registry", type: "registry.vm.registered", payload: { id: 4 } });
      store.append({ source: "board", type: "board.task.status_changed", payload: { id: 5 }, agent: "agent-a" });
    });

    it("returns all events by default", () => {
      const events = store.query();
      expect(events.length).toBe(5);
    });

    it("filters by source", () => {
      const events = store.query({ source: "board" });
      expect(events.length).toBe(3);
      expect(events.every((e) => e.source === "board")).toBe(true);
    });

    it("filters by exact type", () => {
      const events = store.query({ type: "board.task.created" });
      expect(events.length).toBe(1);
    });

    it("filters by wildcard type", () => {
      const events = store.query({ type: "board.*" });
      expect(events.length).toBe(3);
    });

    it("filters by agent", () => {
      const events = store.query({ agent: "agent-a" });
      expect(events.length).toBe(3);
    });

    it("filters by since (ISO timestamp)", () => {
      const allEvents = store.query();
      const since = allEvents[2].timestamp;
      const events = store.query({ since });
      expect(events.length).toBeGreaterThanOrEqual(3);
    });

    it("filters by since (ULID event_id)", () => {
      const allEvents = store.query();
      const sinceUlid = allEvents[1].eventId;
      const events = store.query({ since: sinceUlid });
      // Should exclude events with event_id <= sinceUlid
      expect(events.every((e) => e.eventId > sinceUlid)).toBe(true);
      // Should include at least some events after the cursor
      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThan(5); // not all 5
    });

    it("filters by sinceId (numeric)", () => {
      const events = store.query({ sinceId: 3 });
      expect(events.length).toBe(2);
      expect(events[0].id).toBe(4);
    });

    it("respects limit", () => {
      const events = store.query({ limit: 2 });
      expect(events.length).toBe(2);
    });

    it("combines filters", () => {
      const events = store.query({ source: "board", agent: "agent-a" });
      expect(events.length).toBe(2);
    });
  });

  describe("stats", () => {
    it("returns correct aggregate stats", () => {
      store.append({ source: "board", type: "board.task.created", payload: {} });
      store.append({ source: "board", type: "board.task.created", payload: {} });
      store.append({ source: "feed", type: "feed.event.published", payload: {} });
      store.append({ source: "registry", type: "registry.vm.registered", payload: {} });

      const stats = store.stats();
      expect(stats.total).toBe(4);
      expect(stats.bySource).toEqual({ board: 2, feed: 1, registry: 1 });
      expect(stats.byType).toEqual({
        "board.task.created": 2,
        "feed.event.published": 1,
        "registry.vm.registered": 1,
      });
      expect(stats.oldest).toBeTruthy();
      expect(stats.newest).toBeTruthy();
    });

    it("returns zero stats for empty log", () => {
      const stats = store.stats();
      expect(stats.total).toBe(0);
      expect(stats.bySource).toEqual({});
      expect(stats.byType).toEqual({});
    });
  });

  describe("subscribe (SSE stream)", () => {
    it("notifies subscribers on append", () => {
      const received: any[] = [];
      store.subscribe((event) => received.push(event));

      store.append({ source: "test", type: "test.event", payload: { x: 1 } });
      store.append({ source: "test", type: "test.event", payload: { x: 2 } });

      expect(received.length).toBe(2);
      expect(received[0].payload).toEqual({ x: 1 });
      expect(received[1].payload).toEqual({ x: 2 });
    });

    it("unsubscribe stops notifications", () => {
      const received: any[] = [];
      const unsub = store.subscribe((event) => received.push(event));

      store.append({ source: "test", type: "test.event", payload: { x: 1 } });
      unsub();
      store.append({ source: "test", type: "test.event", payload: { x: 2 } });

      expect(received.length).toBe(1);
    });

    it("subscriber errors don't break append", () => {
      store.subscribe(() => {
        throw new Error("boom");
      });

      // Should not throw
      const record = store.append({ source: "test", type: "test.event", payload: {} });
      expect(record.id).toBe(1);
    });
  });

  describe("latestId", () => {
    it("returns 0 for empty log", () => {
      expect(store.latestId()).toBe(0);
    });

    it("returns the latest auto-increment id", () => {
      store.append({ source: "test", type: "test.event", payload: {} });
      store.append({ source: "test", type: "test.event", payload: {} });
      store.append({ source: "test", type: "test.event", payload: {} });
      expect(store.latestId()).toBe(3);
    });
  });

  describe("performance", () => {
    it("appends 1000 events in under 1 second", () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        store.append({
          source: "perf",
          type: "perf.test",
          payload: { iteration: i, data: "x".repeat(100) },
          agent: `agent-${i % 10}`,
        });
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);

      const stats = store.stats();
      expect(stats.total).toBe(1000);
    });
  });
});
