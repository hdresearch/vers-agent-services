import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventLogStore, ValidationError } from "./store.js";
import type { EventFilters } from "./store.js";

export const eventRoutes = new Hono();

// POST / — Manually append an event (for external sources)
eventRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const event = eventLogStore.append({
      source: input.source as string,
      type: input.type as string,
      payload: input.payload,
      agent: input.agent as string | undefined,
      metadata: input.metadata as Record<string, unknown> | undefined,
    });
    return c.json(event, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET / — Query the event log
eventRoutes.get("/", (c) => {
  const filters: EventFilters = {};

  const source = c.req.query("source");
  const type = c.req.query("type");
  const agent = c.req.query("agent");
  const since = c.req.query("since");
  const sinceId = c.req.query("since_id");
  const limitStr = c.req.query("limit");

  if (source) filters.source = source;
  if (type) filters.type = type;
  if (agent) filters.agent = agent;
  if (since) filters.since = since;
  if (sinceId) filters.sinceId = parseInt(sinceId, 10);
  if (limitStr) filters.limit = parseInt(limitStr, 10);

  const events = eventLogStore.query(filters);
  return c.json({ events, count: events.length });
});

// GET /stats — Aggregate statistics
eventRoutes.get("/stats", (c) => {
  return c.json(eventLogStore.stats());
});

// GET /stream — SSE stream of new events
eventRoutes.get("/stream", (c) => {
  const sinceIdStr = c.req.query("since_id");
  const source = c.req.query("source");
  const type = c.req.query("type");

  return streamSSE(c, async (stream) => {
    // Replay missed events if since_id provided
    if (sinceIdStr) {
      const sinceId = parseInt(sinceIdStr, 10);
      const missed = eventLogStore.query({ sinceId, limit: 1000 });
      for (const event of missed) {
        if (source && event.source !== source) continue;
        if (type && event.type !== type) continue;
        await stream.writeSSE({
          id: String(event.id),
          data: JSON.stringify(event),
        });
      }
    }

    // Subscribe to new events
    const unsubscribe = eventLogStore.subscribe((event) => {
      if (source && event.source !== source) return;
      if (type && event.type !== type) return;
      stream
        .writeSSE({
          id: String(event.id),
          data: JSON.stringify(event),
        })
        .catch(() => {});
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

    // Keep alive
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    unsubscribe();
    clearInterval(heartbeat);
  });
});
