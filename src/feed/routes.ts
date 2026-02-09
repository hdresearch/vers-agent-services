import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { FeedStore, VALID_EVENT_TYPES } from "./store.js";
import type { PublishInput, FeedEvent } from "./store.js";

export const feedStore = new FeedStore();
export const feedRoutes = new Hono();

// POST /events — Publish an event
feedRoutes.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.agent || typeof input.agent !== "string") {
    return c.json({ error: "Missing or invalid 'agent' field" }, 400);
  }
  if (!input.type || !VALID_EVENT_TYPES.has(input.type as string)) {
    return c.json(
      { error: `Invalid 'type'. Must be one of: ${[...VALID_EVENT_TYPES].join(", ")}` },
      400,
    );
  }
  if (!input.summary || typeof input.summary !== "string") {
    return c.json({ error: "Missing or invalid 'summary' field" }, 400);
  }

  const event = feedStore.publish(input as PublishInput);
  return c.json(event, 201);
});

// GET /events — List events with optional filters
feedRoutes.get("/events", (c) => {
  const agent = c.req.query("agent");
  const type = c.req.query("type");
  const since = c.req.query("since");
  const limitStr = c.req.query("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  const events = feedStore.list({ agent, type, since, limit });
  return c.json(events);
});

// GET /events/:id — Get single event
feedRoutes.get("/events/:id", (c) => {
  const id = c.req.param("id");
  const event = feedStore.get(id);
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  return c.json(event);
});

// DELETE /events — Clear all events
feedRoutes.delete("/events", (c) => {
  feedStore.clear();
  return c.json({ ok: true });
});

// GET /stats — Summary statistics
feedRoutes.get("/stats", (c) => {
  return c.json(feedStore.stats());
});

// GET /stream — SSE stream of real-time events
feedRoutes.get("/stream", (c) => {
  const agent = c.req.query("agent");
  const sinceId = c.req.query("since");

  return streamSSE(c, async (stream) => {
    // Replay events since a ULID if provided (for reconnection)
    if (sinceId) {
      const missed = feedStore.eventsSince(sinceId, agent);
      for (const event of missed) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    }

    // Subscribe to new events
    const unsubscribe = feedStore.subscribe((event: FeedEvent) => {
      if (agent && event.agent !== agent) return;
      stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    });

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      stream.write(": heartbeat\n\n").catch(() => {});
    }, 15000);

    // Cleanup on disconnect
    stream.onAbort(() => {
      unsubscribe();
      clearInterval(heartbeat);
    });

    // Keep stream alive — wait until aborted
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    unsubscribe();
    clearInterval(heartbeat);
  });
});
