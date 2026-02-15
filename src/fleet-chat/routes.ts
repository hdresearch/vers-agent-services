import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { FleetChatStore } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";

export const fleetChatStore = new FleetChatStore();

// ── Authenticated routes (bearer auth applied externally) ──────────────────

export const fleetChatRoutes = new Hono();

// POST /channels — Open a channel with another fleet
fleetChatRoutes.post("/channels", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const channel = fleetChatStore.createChannel({
      remoteFleet: input.remoteFleet as any,
      metadata: input.metadata as Record<string, unknown> | undefined,
    });
    emit("fleet-chat", "fleet-chat.channel.created", {
      channelId: channel.id,
      remoteFleet: channel.remoteFleet.name,
      remoteEndpoint: channel.remoteFleet.endpoint,
    });
    return c.json(channel, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /channels — List channels
fleetChatRoutes.get("/channels", (c) => {
  const status = c.req.query("status") as any;
  const channels = fleetChatStore.listChannels(status ? { status } : undefined);
  return c.json({ channels, count: channels.length });
});

// GET /channels/:id — Get channel details
fleetChatRoutes.get("/channels/:id", (c) => {
  try {
    const channel = fleetChatStore.getChannel(c.req.param("id"));
    return c.json(channel);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// PATCH /channels/:id — Update channel status
fleetChatRoutes.patch("/channels/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const channel = fleetChatStore.updateChannelStatus(
      c.req.param("id"),
      input.status as any,
    );
    return c.json(channel);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /channels/:id/messages — Send a message on a channel
fleetChatRoutes.post("/channels/:id/messages", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const msg = fleetChatStore.sendMessage({
      channelId: c.req.param("id"),
      content: input.content as string,
      type: input.type as any,
      replyTo: input.replyTo as string | undefined,
      metadata: input.metadata as Record<string, unknown> | undefined,
    });
    emit("fleet-chat", "fleet-chat.message.sent", {
      messageId: msg.id,
      channelId: msg.channelId,
      type: msg.type,
      to: msg.to.name,
    }, msg.from.name);
    return c.json(msg, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /channels/:id/messages — Get messages on a channel (supports polling)
fleetChatRoutes.get("/channels/:id/messages", (c) => {
  const channelId = c.req.param("id");
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const threadId = c.req.query("threadId") || undefined;

  // Check for SSE request
  const accept = c.req.header("Accept");
  if (accept === "text/event-stream") {
    return streamSSE(c, async (stream) => {
      // Send existing messages first
      try {
        const existing = fleetChatStore.getMessages(channelId, { limit, after, before, threadId });
        for (const msg of existing) {
          await stream.writeSSE({
            data: JSON.stringify(msg),
            event: "message",
            id: msg.id,
          });
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          await stream.writeSSE({ data: JSON.stringify({ error: (err as Error).message }), event: "error" });
          return;
        }
      }

      // Stream new messages
      const removeListener = fleetChatStore.addInboxListener(async (msg) => {
        if (msg.channelId === channelId) {
          try {
            await stream.writeSSE({
              data: JSON.stringify(msg),
              event: "message",
              id: msg.id,
            });
          } catch { /* stream closed */ }
        }
      });

      // Keep alive
      const keepAlive = setInterval(async () => {
        try {
          await stream.writeSSE({ data: "", event: "ping" });
        } catch {
          clearInterval(keepAlive);
        }
      }, 30_000);

      stream.onAbort(() => {
        removeListener();
        clearInterval(keepAlive);
      });

      // Hold stream open
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  }

  try {
    const messages = fleetChatStore.getMessages(channelId, { limit, after, before, threadId });
    return c.json({ messages, count: messages.length });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// GET /identity — Get local fleet identity
fleetChatRoutes.get("/identity", (c) => {
  const identity = fleetChatStore.getLocalIdentity();
  if (!identity) return c.json({ error: "Local identity not set" }, 404);
  return c.json(identity);
});

// POST /identity — Set local fleet identity
fleetChatRoutes.post("/identity", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    fleetChatStore.setLocalIdentity(body as any);
    return c.json(fleetChatStore.getLocalIdentity());
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /trusted — List trusted endpoints
fleetChatRoutes.get("/trusted", (c) => {
  const endpoints = fleetChatStore.getTrustedEndpoints();
  return c.json({ endpoints, count: endpoints.length });
});

// POST /trusted — Add a trusted endpoint
fleetChatRoutes.post("/trusted", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const endpoint = fleetChatStore.addTrustedEndpoint(body as any);
    return c.json(endpoint, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// DELETE /trusted/:endpoint — Remove a trusted endpoint
fleetChatRoutes.delete("/trusted/:endpoint", (c) => {
  const endpoint = decodeURIComponent(c.req.param("endpoint"));
  const removed = fleetChatStore.removeTrustedEndpoint(endpoint);
  if (!removed) return c.json({ error: "Endpoint not found" }, 404);
  return c.json({ removed: true });
});

// GET /quarantine — List quarantined messages
fleetChatRoutes.get("/quarantine", (c) => {
  const quarantine = fleetChatStore.getQuarantine();
  return c.json({ quarantine, count: quarantine.length });
});

// POST /quarantine/:id/approve — Approve a quarantined message
fleetChatRoutes.post("/quarantine/:id/approve", (c) => {
  try {
    const msg = fleetChatStore.approveQuarantined(c.req.param("id"));
    return c.json(msg);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST /quarantine/:id/reject — Reject a quarantined message
fleetChatRoutes.post("/quarantine/:id/reject", (c) => {
  try {
    fleetChatStore.rejectQuarantined(c.req.param("id"));
    return c.json({ rejected: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// ── Public routes (no bearer auth — verified by sender's public key) ──────

export const fleetChatPublicRoutes = new Hono();

// POST /inbox — Receive a message from another fleet (PUBLIC endpoint)
fleetChatPublicRoutes.post("/inbox", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    // Normalize sender field: accept both "from" and "sender"
    const input = body as Record<string, unknown>;
    if (!input.from && input.sender) {
      input.from = input.sender;
    }
    // Normalize recipient field: accept both "to" and "recipient"
    if (!input.to && input.recipient) {
      input.to = input.recipient;
    }
    const result = fleetChatStore.receiveInbound(input as any);

    if (result.quarantined) {
      emit("fleet-chat", "fleet-chat.message.quarantined", {
        quarantineId: result.quarantined.id,
        reason: result.quarantined.reason,
        from: result.quarantined.rawMessage.from?.name,
      });
      return c.json(
        {
          received: true,
          quarantined: true,
          message: "Message from unknown sender has been quarantined for review",
        },
        202,
      );
    }

    if (result.message) {
      emit("fleet-chat", "fleet-chat.message.received", {
        messageId: result.message.id,
        channelId: result.message.channelId,
        type: result.message.type,
        from: result.message.from.name,
      });
      return c.json(
        {
          received: true,
          messageId: result.message.id,
          channelId: result.message.channelId,
        },
        200,
      );
    }

    return c.json({ received: false, error: "Unknown processing error" }, 500);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /inbox/stream — SSE stream of ALL incoming messages (PUBLIC — for agent polling)
fleetChatPublicRoutes.get("/inbox/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const removeListener = fleetChatStore.addInboxListener(async (msg) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify(msg),
          event: "message",
          id: msg.id,
        });
      } catch { /* stream closed */ }
    });

    // Keep alive
    const keepAlive = setInterval(async () => {
      try {
        await stream.writeSSE({ data: "", event: "ping" });
      } catch {
        clearInterval(keepAlive);
      }
    }, 30_000);

    stream.onAbort(() => {
      removeListener();
      clearInterval(keepAlive);
    });

    // Hold stream open
    await new Promise<void>((resolve) => {
      stream.onAbort(resolve);
    });
  });
});
