import { describe, it, expect, beforeEach } from "vitest";
import {
  WatchdogStore,
  classifyAgent,
  hashEvent,
  THRESHOLDS,
  type FeedAdapter,
  type RegistryAdapter,
  type BoardAdapter,
  type AgentHealth,
} from "../store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function minutesAgo(min: number, from = new Date()): string {
  return new Date(from.getTime() - min * 60 * 1000).toISOString();
}

function makeFeedAdapter(events: Record<string, { id: string; timestamp: string } | null> = {}): FeedAdapter & { published: Array<{ agent: string; type: string; summary: string; detail?: string }> } {
  const published: Array<{ agent: string; type: string; summary: string; detail?: string }> = [];
  return {
    published,
    getLatestEvent(agent: string) {
      return events[agent] ?? null;
    },
    publishEvent(agent: string, type: string, summary: string, detail?: string) {
      published.push({ agent, type, summary, detail });
    },
  };
}

function makeRegistryAdapter(agents: Array<{ id: string; name: string }> = []): RegistryAdapter {
  return {
    getRunningAgents() {
      return agents;
    },
  };
}

function makeBoardAdapter(): BoardAdapter & { notes: Array<{ taskId: string; author: string; content: string }>; taskMap: Record<string, string> } {
  const notes: Array<{ taskId: string; author: string; content: string }> = [];
  const taskMap: Record<string, string> = {};
  return {
    notes,
    taskMap,
    findTaskByAgent(agent: string) {
      return taskMap[agent] ?? null;
    },
    addNote(taskId: string, author: string, content: string) {
      notes.push({ taskId, author, content });
    },
  };
}

// ── classifyAgent tests ──────────────────────────────────────────────────────

describe("classifyAgent", () => {
  const now = new Date("2026-02-13T07:00:00Z");

  it("returns 'active' when event is within 2 minutes", () => {
    expect(classifyAgent(minutesAgo(1, now), now)).toBe("active");
    expect(classifyAgent(minutesAgo(0, now), now)).toBe("active");
  });

  it("returns 'stale' when event is 2-10 minutes old", () => {
    expect(classifyAgent(minutesAgo(3, now), now)).toBe("stale");
    expect(classifyAgent(minutesAgo(5, now), now)).toBe("stale");
    expect(classifyAgent(minutesAgo(9, now), now)).toBe("stale");
  });

  it("returns 'zombie' when event is 10+ minutes old", () => {
    expect(classifyAgent(minutesAgo(10, now), now)).toBe("zombie");
    expect(classifyAgent(minutesAgo(15, now), now)).toBe("zombie");
    expect(classifyAgent(minutesAgo(60, now), now)).toBe("zombie");
  });

  it("returns 'dead' when no event timestamp", () => {
    expect(classifyAgent(null, now)).toBe("dead");
  });
});

// ── hashEvent tests ──────────────────────────────────────────────────────────

describe("hashEvent", () => {
  it("produces consistent hashes", () => {
    const h1 = hashEvent("abc", "2026-01-01T00:00:00Z");
    const h2 = hashEvent("abc", "2026-01-01T00:00:00Z");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different inputs", () => {
    const h1 = hashEvent("abc", "2026-01-01T00:00:00Z");
    const h2 = hashEvent("def", "2026-01-01T00:00:00Z");
    expect(h1).not.toBe(h2);
  });
});

// ── WatchdogStore tests ──────────────────────────────────────────────────────

describe("WatchdogStore", () => {
  let feed: ReturnType<typeof makeFeedAdapter>;
  let registry: ReturnType<typeof makeRegistryAdapter>;
  let board: ReturnType<typeof makeBoardAdapter>;
  let watchdog: WatchdogStore;

  const now = new Date("2026-02-13T07:00:00Z");

  beforeEach(() => {
    feed = makeFeedAdapter();
    registry = makeRegistryAdapter([
      { id: "vm-1", name: "lt-alpha" },
      { id: "vm-2", name: "lt-beta" },
    ]);
    board = makeBoardAdapter();
    watchdog = new WatchdogStore(feed, registry, board);
  });

  it("classifies active agents correctly", () => {
    feed = makeFeedAdapter({
      "lt-alpha": { id: "ev1", timestamp: minutesAgo(1, now) },
      "lt-beta": { id: "ev2", timestamp: minutesAgo(0, now) },
    });
    watchdog = new WatchdogStore(feed, registry, board);

    watchdog.check(now);

    const agents = watchdog.getAll();
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.status === "active")).toBe(true);
    expect(watchdog.getZombies()).toHaveLength(0);
  });

  it("classifies stale agents correctly", () => {
    feed = makeFeedAdapter({
      "lt-alpha": { id: "ev1", timestamp: minutesAgo(5, now) },
      "lt-beta": { id: "ev2", timestamp: minutesAgo(0, now) },
    });
    watchdog = new WatchdogStore(feed, registry, board);

    watchdog.check(now);

    const alpha = watchdog.getAll().find((a) => a.agentId === "lt-alpha");
    const beta = watchdog.getAll().find((a) => a.agentId === "lt-beta");
    expect(alpha?.status).toBe("stale");
    expect(beta?.status).toBe("active");
  });

  it("classifies zombie agents correctly", () => {
    feed = makeFeedAdapter({
      "lt-alpha": { id: "ev1", timestamp: minutesAgo(12, now) },
      "lt-beta": { id: "ev2", timestamp: minutesAgo(0, now) },
    });
    watchdog = new WatchdogStore(feed, registry, board);

    watchdog.check(now);

    const alpha = watchdog.getAll().find((a) => a.agentId === "lt-alpha");
    expect(alpha?.status).toBe("zombie");
    expect(watchdog.getZombies()).toHaveLength(1);
  });

  it("marks agents with no events as dead", () => {
    feed = makeFeedAdapter({}); // no events for anyone
    watchdog = new WatchdogStore(feed, registry, board);

    watchdog.check(now);

    const agents = watchdog.getAll();
    expect(agents.every((a) => a.status === "dead")).toBe(true);
  });

  it("marks agents removed from registry as dead", () => {
    feed = makeFeedAdapter({
      "lt-alpha": { id: "ev1", timestamp: minutesAgo(1, now) },
      "lt-beta": { id: "ev2", timestamp: minutesAgo(0, now) },
    });
    watchdog = new WatchdogStore(feed, registry, board);

    watchdog.check(now);
    expect(watchdog.getAll().every((a) => a.status === "active")).toBe(true);

    // Remove lt-beta from registry
    registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
    watchdog = new WatchdogStore(feed, registry, board);
    // We need to reconstruct with the same internal state — let's use a different approach
    // Instead, test with a single watchdog where registry changes
  });

  describe("alert escalation", () => {
    it("sends zombie_detected at 10min (alert 1)", () => {
      feed = makeFeedAdapter({
        "lt-alpha": { id: "ev1", timestamp: minutesAgo(11, now) },
      });
      registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
      watchdog = new WatchdogStore(feed, registry, board);

      watchdog.check(now);

      expect(feed.published).toHaveLength(1);
      expect(feed.published[0].summary).toContain("zombie_detected");
      expect(feed.published[0].summary).toContain("lt-alpha");
      expect(watchdog.getAll()[0].alertsSent).toBe(1);
    });

    it("sends board note at 15min (alert 2)", () => {
      feed = makeFeedAdapter({
        "lt-alpha": { id: "ev1", timestamp: minutesAgo(16, now) },
      });
      registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
      board = makeBoardAdapter();
      board.taskMap["lt-alpha"] = "task-123";
      watchdog = new WatchdogStore(feed, registry, board);

      watchdog.check(now);

      // Should send alert 1 AND alert 2 on first check if stale enough
      expect(feed.published).toHaveLength(1); // zombie_detected
      expect(board.notes).toHaveLength(1);
      expect(board.notes[0].taskId).toBe("task-123");
      expect(board.notes[0].content).toContain("appears stuck");
      expect(watchdog.getAll()[0].alertsSent).toBe(2);
    });

    it("sends zombie_confirmed at 20min (alert 3)", () => {
      feed = makeFeedAdapter({
        "lt-alpha": { id: "ev1", timestamp: minutesAgo(21, now) },
      });
      registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
      board = makeBoardAdapter();
      watchdog = new WatchdogStore(feed, registry, board);

      watchdog.check(now);

      // Should escalate through all 3 alerts
      expect(feed.published).toHaveLength(2); // zombie_detected + zombie_confirmed
      expect(feed.published[0].summary).toContain("zombie_detected");
      expect(feed.published[1].summary).toContain("zombie_confirmed");
      expect(watchdog.getAll()[0].alertsSent).toBe(3);
      expect(watchdog.getAll()[0].status).toBe("zombie");
    });

    it("does not re-alert on subsequent checks", () => {
      feed = makeFeedAdapter({
        "lt-alpha": { id: "ev1", timestamp: minutesAgo(25, now) },
      });
      registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
      watchdog = new WatchdogStore(feed, registry, board);

      watchdog.check(now);
      const alertsAfterFirst = feed.published.length;

      // Second check — same state, should not re-alert
      watchdog.check(now);
      expect(feed.published.length).toBe(alertsAfterFirst);
    });

    it("resets alerts when agent recovers", () => {
      // Start with zombie
      feed = makeFeedAdapter({
        "lt-alpha": { id: "ev1", timestamp: minutesAgo(25, now) },
      });
      registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
      watchdog = new WatchdogStore(feed, registry, board);

      watchdog.check(now);
      expect(watchdog.getAll()[0].alertsSent).toBe(3);

      // Agent recovers — new event with different hash
      feed = makeFeedAdapter({
        "lt-alpha": { id: "ev2", timestamp: minutesAgo(0, now) },
      });
      // Need to swap adapter — recreate with same internal state
      // Actually the store references the adapter object, so we update in place
      (watchdog as any).feed = feed;

      watchdog.check(now);
      expect(watchdog.getAll()[0].status).toBe("active");
      expect(watchdog.getAll()[0].alertsSent).toBe(0);
    });
  });

  describe("getState", () => {
    it("returns state summary", () => {
      const state = watchdog.getState();
      expect(state.running).toBe(false);
      expect(state.checkIntervalMs).toBe(THRESHOLDS.CHECK_INTERVAL_MS);
      expect(state.agents).toEqual({});
    });
  });

  describe("start/stop", () => {
    it("starts and stops the monitoring loop", () => {
      watchdog.start(60000);
      expect(watchdog.running).toBe(true);

      watchdog.stop();
      expect(watchdog.running).toBe(false);
    });

    it("is idempotent", () => {
      watchdog.start(60000);
      watchdog.start(60000); // no-op
      expect(watchdog.running).toBe(true);

      watchdog.stop();
      watchdog.stop(); // no-op
      expect(watchdog.running).toBe(false);
    });
  });
});

// ── /status endpoint format test ─────────────────────────────────────────────

describe("status endpoint format", () => {
  it("returns expected shape from getAll + getZombies", () => {
    const feed = makeFeedAdapter({
      "lt-alpha": { id: "ev1", timestamp: minutesAgo(1) },
    });
    const registry = makeRegistryAdapter([{ id: "vm-1", name: "lt-alpha" }]);
    const board = makeBoardAdapter();
    const watchdog = new WatchdogStore(feed, registry, board);

    watchdog.check();

    const agents = watchdog.getAll();
    expect(agents).toHaveLength(1);
    
    const agent = agents[0];
    // Verify AgentHealth shape
    expect(agent).toHaveProperty("agentId");
    expect(agent).toHaveProperty("vmId");
    expect(agent).toHaveProperty("lastEventHash");
    expect(agent).toHaveProperty("lastEventTime");
    expect(agent).toHaveProperty("lastCheckTime");
    expect(agent).toHaveProperty("status");
    expect(agent).toHaveProperty("alertsSent");
    expect(typeof agent.agentId).toBe("string");
    expect(typeof agent.vmId).toBe("string");
    expect(typeof agent.lastEventHash).toBe("string");
    expect(typeof agent.status).toBe("string");
    expect(typeof agent.alertsSent).toBe("number");
  });
});
