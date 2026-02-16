import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBus, patternToRegex, type FleetEvent } from "../eventbus.js";

function makeEvent(type: string, source = "test"): FleetEvent {
  return {
    type,
    source,
    timestamp: new Date().toISOString(),
    data: { test: true },
  };
}

describe("patternToRegex", () => {
  it("matches exact strings", () => {
    const re = patternToRegex("board.task.created");
    expect(re.test("board.task.created")).toBe(true);
    expect(re.test("board.task.updated")).toBe(false);
    expect(re.test("board.task")).toBe(false);
  });

  it("matches single-segment wildcard *", () => {
    const re = patternToRegex("board.*");
    expect(re.test("board.created")).toBe(true);
    expect(re.test("board.updated")).toBe(true);
    expect(re.test("board.task.created")).toBe(false); // * = one segment only
    expect(re.test("feed.created")).toBe(false);
  });

  it("matches multi-segment wildcard **", () => {
    const re = patternToRegex("board.**");
    expect(re.test("board.task.created")).toBe(true);
    expect(re.test("board.task.updated")).toBe(true);
    expect(re.test("board.x")).toBe(true);
    expect(re.test("board.x.y.z")).toBe(true);
    expect(re.test("feed.event")).toBe(false);
  });

  it("matches catch-all **", () => {
    const re = patternToRegex("**");
    expect(re.test("board.task.created")).toBe(true);
    expect(re.test("a")).toBe(true);
    expect(re.test("a.b.c.d.e")).toBe(true);
  });

  it("matches single wildcard at start", () => {
    const re = patternToRegex("*.created");
    expect(re.test("board.created")).toBe(true);
    expect(re.test("feed.created")).toBe(true);
    expect(re.test("board.task.created")).toBe(false);
  });

  it("handles mixed patterns", () => {
    const re = patternToRegex("board.task.*");
    expect(re.test("board.task.created")).toBe(true);
    expect(re.test("board.task.updated")).toBe(true);
    expect(re.test("board.task")).toBe(false);
    expect(re.test("board.task.a.b")).toBe(false);
  });
});

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus(100);
  });

  it("delivers events to matching subscribers", () => {
    const received: FleetEvent[] = [];
    bus.subscribe("board.**", (e) => received.push(e));

    bus.publish(makeEvent("board.task.created"));
    bus.publish(makeEvent("board.task.updated"));
    bus.publish(makeEvent("feed.event.published"));

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("board.task.created");
    expect(received[1].type).toBe("board.task.updated");
  });

  it("supports exact pattern matching", () => {
    const received: FleetEvent[] = [];
    bus.subscribe("board.task.created", (e) => received.push(e));

    bus.publish(makeEvent("board.task.created"));
    bus.publish(makeEvent("board.task.updated"));

    expect(received).toHaveLength(1);
  });

  it("supports catch-all ** pattern", () => {
    const received: FleetEvent[] = [];
    bus.subscribe("**", (e) => received.push(e));

    bus.publish(makeEvent("board.task.created"));
    bus.publish(makeEvent("feed.event.published"));
    bus.publish(makeEvent("cryo.agent.spawned"));

    expect(received).toHaveLength(3);
  });

  it("unsubscribe stops delivery", () => {
    const received: FleetEvent[] = [];
    const unsub = bus.subscribe("**", (e) => received.push(e));

    bus.publish(makeEvent("a.b"));
    unsub();
    bus.publish(makeEvent("c.d"));

    expect(received).toHaveLength(1);
  });

  it("subscriber errors don't break other subscribers", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: FleetEvent[] = [];

    bus.subscribe("**", () => {
      throw new Error("boom");
    });
    bus.subscribe("**", (e) => received.push(e));

    bus.publish(makeEvent("test.event"));

    expect(received).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("buffers events for replay", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000).toISOString();

    bus.publish({
      type: "board.task.created",
      source: "board",
      timestamp: now.toISOString(),
      data: { id: 1 },
    });
    bus.publish({
      type: "feed.event.published",
      source: "feed",
      timestamp: now.toISOString(),
      data: { id: 2 },
    });

    const all = bus.replay(past);
    expect(all).toHaveLength(2);

    const boardOnly = bus.replay(past, "board.**");
    expect(boardOnly).toHaveLength(1);
    expect(boardOnly[0].type).toBe("board.task.created");
  });

  it("replay respects timestamp filter", () => {
    const t1 = new Date("2025-01-01T00:00:00Z").toISOString();
    const t2 = new Date("2025-01-02T00:00:00Z").toISOString();
    const t3 = new Date("2025-01-03T00:00:00Z").toISOString();

    bus.publish({ type: "a.b", source: "x", timestamp: t1, data: null });
    bus.publish({ type: "a.c", source: "x", timestamp: t2, data: null });
    bus.publish({ type: "a.d", source: "x", timestamp: t3, data: null });

    // Since t2 → only t3 should come back
    const events = bus.replay(t2);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("a.d");
  });

  it("ring buffer evicts old events", () => {
    const smallBus = new EventBus(5);
    for (let i = 0; i < 10; i++) {
      smallBus.publish(makeEvent(`type.${i}`));
    }
    expect(smallBus.bufferedEventCount).toBe(5);
    const events = smallBus.replay("1970-01-01T00:00:00Z");
    expect(events[0].type).toBe("type.5");
  });

  it("tracks subscriber count", () => {
    expect(bus.subscriberCount).toBe(0);
    const unsub1 = bus.subscribe("a.*", () => {});
    const unsub2 = bus.subscribe("b.**", () => {});
    expect(bus.subscriberCount).toBe(2);
    unsub1();
    expect(bus.subscriberCount).toBe(1);
    unsub2();
    expect(bus.subscriberCount).toBe(0);
  });

  it("reset clears everything", () => {
    bus.subscribe("**", () => {});
    bus.publish(makeEvent("a.b"));
    expect(bus.subscriberCount).toBe(1);
    expect(bus.bufferedEventCount).toBe(1);

    bus.reset();
    expect(bus.subscriberCount).toBe(0);
    expect(bus.bufferedEventCount).toBe(0);
  });

  it("multiple subscribers on different patterns", () => {
    const boardEvents: string[] = [];
    const feedEvents: string[] = [];
    const allEvents: string[] = [];

    bus.subscribe("board.**", (e) => boardEvents.push(e.type));
    bus.subscribe("feed.**", (e) => feedEvents.push(e.type));
    bus.subscribe("**", (e) => allEvents.push(e.type));

    bus.publish(makeEvent("board.task.created"));
    bus.publish(makeEvent("feed.event.published"));
    bus.publish(makeEvent("cryo.agent.spawned"));

    expect(boardEvents).toEqual(["board.task.created"]);
    expect(feedEvents).toEqual(["feed.event.published"]);
    expect(allEvents).toEqual([
      "board.task.created",
      "feed.event.published",
      "cryo.agent.spawned",
    ]);
  });
});
