import { Hono } from "hono";
import { GossipStore } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";

export const gossipStore = new GossipStore();
export const gossipRoutes = new Hono();

// POST /messages — Send a message
gossipRoutes.post("/messages", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const msg = gossipStore.send({
      from: input.from as string,
      to: input.to as string,
      type: input.type as any,
      subject: input.subject as string,
      body: input.body as string,
      priority: input.priority as any,
      replyTo: input.replyTo as string | undefined,
    });
    emit("gossip", "gossip.message.sent", { id: msg.id, to: msg.to, type: msg.type, subject: msg.subject }, msg.from);
    return c.json(msg, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /messages?to=:name&unread=true&limit=50&offset=0
gossipRoutes.get("/messages", (c) => {
  const to = c.req.query("to");
  if (!to) return c.json({ error: "Query param 'to' is required" }, 400);

  const unreadOnly = c.req.query("unread") === "true";
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;

  const result = gossipStore.getInbox(to, { unreadOnly, limit, offset });
  return c.json({ messages: result.messages, count: result.messages.length, total: result.total });
});

// GET /threads/:id
gossipRoutes.get("/threads/:id", (c) => {
  const threadId = c.req.param("id");
  try {
    const messages = gossipStore.getThread(threadId);
    return c.json({ threadId, messages, count: messages.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /messages/:id/read — Mark message as read
gossipRoutes.post("/messages/:id/read", (c) => {
  try {
    const msg = gossipStore.markRead(c.req.param("id"));
    return c.json(msg);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /broadcast — Broadcast to all agents
gossipRoutes.post("/broadcast", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const msg = gossipStore.broadcast({
      from: input.from as string,
      type: input.type as any,
      subject: input.subject as string,
      body: input.body as string,
      priority: input.priority as any,
    });
    emit("gossip", "gossip.broadcast", { id: msg.id, type: msg.type, subject: msg.subject }, msg.from);
    return c.json(msg, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /activity — Summary for orchestrator
gossipRoutes.get("/activity", (c) => {
  const activity = gossipStore.getActivity();
  return c.json(activity);
});
