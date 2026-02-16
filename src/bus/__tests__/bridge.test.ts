import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { busRoutes } from "../bridge.js";
import { bus } from "../eventbus.js";

// Mount routes on a test app
const app = new Hono();
app.route("/bus", busRoutes);

beforeEach(() => {
  bus.reset();
});

describe("POST /bus/publish", () => {
  it("publishes a valid event", async () => {
    const res = await app.request("/bus/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "test.event",
        source: "unit-test",
        data: { hello: "world" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.event.type).toBe("test.event");
    expect(body.event.source).toBe("unit-test");
    expect(body.event.data).toEqual({ hello: "world" });
    expect(body.event.timestamp).toBeTruthy();
  });

  it("rejects missing type", async () => {
    const res = await app.request("/bus/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing source", async () => {
    const res = await app.request("/bus/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "test.event" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const res = await app.request("/bus/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("delivers to bus subscribers", async () => {
    const received: string[] = [];
    bus.subscribe("test.**", (e) => received.push(e.type));

    await app.request("/bus/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "test.thing.happened",
        source: "unit-test",
        data: null,
      }),
    });

    expect(received).toEqual(["test.thing.happened"]);
  });
});

describe("GET /bus/replay", () => {
  it("returns 400 without since param", async () => {
    const res = await app.request("/bus/replay");
    expect(res.status).toBe(400);
  });

  it("replays events since timestamp", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();

    // Publish some events directly to bus
    bus.publish({
      type: "board.task.created",
      source: "board",
      timestamp: new Date().toISOString(),
      data: { id: 1 },
    });
    bus.publish({
      type: "feed.event.published",
      source: "feed",
      timestamp: new Date().toISOString(),
      data: { id: 2 },
    });

    const res = await app.request(`/bus/replay?since=${past}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.events).toHaveLength(2);
  });

  it("filters by pattern", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();

    bus.publish({
      type: "board.task.created",
      source: "board",
      timestamp: new Date().toISOString(),
      data: {},
    });
    bus.publish({
      type: "feed.event.published",
      source: "feed",
      timestamp: new Date().toISOString(),
      data: {},
    });

    const res = await app.request(`/bus/replay?since=${past}&pattern=board.**`);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.events[0].type).toBe("board.task.created");
  });
});

describe("GET /bus/stats", () => {
  it("returns diagnostics", async () => {
    bus.subscribe("**", () => {});
    bus.publish({
      type: "x.y",
      source: "test",
      timestamp: new Date().toISOString(),
      data: null,
    });

    const res = await app.request("/bus/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscribers).toBe(1);
    expect(body.buffered).toBe(1);
  });
});
