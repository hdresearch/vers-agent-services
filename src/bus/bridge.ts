/**
 * Cross-process event bus bridge.
 *
 * Exposes HTTP endpoints so external services can publish/subscribe:
 *   POST /bus/publish      — publish an event
 *   GET  /bus/stream       — SSE stream (filterable by pattern)
 *   GET  /bus/replay       — replay missed events since a timestamp
 *   GET  /bus/stats        — bus diagnostics
 *
 * Internally wires to the in-process EventBus singleton.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bus, type FleetEvent } from "./eventbus.js";

export const busRoutes = new Hono();

// POST /publish — any service can publish an event
busRoutes.post("/publish", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const input = body as Record<string, unknown>;
  if (!input.type || typeof input.type !== "string") {
    return c.json({ error: "Missing or invalid 'type' field" }, 400);
  }
  if (!input.source || typeof input.source !== "string") {
    return c.json({ error: "Missing or invalid 'source' field" }, 400);
  }

  const event: FleetEvent = {
    type: input.type as string,
    source: input.source as string,
    timestamp: (input.timestamp as string) || new Date().toISOString(),
    data: input.data ?? null,
    agent: input.agent as string | undefined,
  };

  bus.publish(event);
  return c.json({ ok: true, event }, 201);
});

// GET /stream — SSE stream of events, filterable by pattern
busRoutes.get("/stream", (c) => {
  const pattern = c.req.query("pattern") || "**";
  const sinceParam = c.req.query("since");

  return streamSSE(c, async (stream) => {
    // Replay missed events if `since` provided
    if (sinceParam) {
      const missed = bus.replay(sinceParam, pattern);
      for (const event of missed) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      }
    }

    // Subscribe to live events
    let alive = true;
    const unsub = bus.subscribe(pattern, (event) => {
      if (!alive) return;
      stream
        .writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
        .catch(() => {
          alive = false;
        });
    });

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      if (!alive) return;
      stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {
        alive = false;
      });
    }, 15_000);

    // Wait until stream is aborted
    stream.onAbort(() => {
      alive = false;
      unsub();
      clearInterval(heartbeat);
    });

    // Keep stream alive — wait until client disconnects
    while (alive) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    unsub();
    clearInterval(heartbeat);
  });
});

// GET /replay — replay events since a timestamp, optionally filtered
busRoutes.get("/replay", (c) => {
  const since = c.req.query("since");
  if (!since) {
    return c.json({ error: "Missing 'since' query parameter (ISO timestamp)" }, 400);
  }
  const pattern = c.req.query("pattern") || "**";
  const events = bus.replay(since, pattern);
  return c.json({ events, count: events.length });
});

// GET /stats — bus diagnostics
busRoutes.get("/stats", (c) => {
  return c.json({
    subscribers: bus.subscriberCount,
    buffered: bus.bufferedEventCount,
  });
});
