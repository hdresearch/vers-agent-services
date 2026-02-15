import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { FleetChatStore } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";
import { signContent, encryptContent } from "./crypto.js";

const PRIVATE_KEY_PATH = process.env.FLEET_PRIVATE_KEY_PATH || "/root/.ssh/fleet-identity";

export const fleetChatStore = new FleetChatStore("data/fleet-chat.json", undefined, {
  privateKeyPath: PRIVATE_KEY_PATH,
  requireSignatures: process.env.REQUIRE_SIGNATURES === "true",
});

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
    const msg = await fleetChatStore.sendMessage({
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

// POST /send — Outbox: sign, optionally encrypt, and deliver to remote fleet
fleetChatRoutes.post("/send", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as Record<string, unknown>;
    const to = input.to as { name: string; endpoint: string; publicKey: string };
    const content = input.content as string;
    const encrypt = input.encrypt === true;
    const type = (input.type as string) || "text";

    if (!to?.name || !to?.endpoint || !to?.publicKey) {
      return c.json({ error: "to.name, to.endpoint, and to.publicKey are required" }, 400);
    }
    if (!content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    const localIdentity = fleetChatStore.getLocalIdentity();
    if (!localIdentity) {
      return c.json({ error: "Local identity not set. POST /fleet-chat/identity first." }, 400);
    }

    // Determine final content and type
    let finalContent = content;
    let finalType = type;

    if (encrypt) {
      // age-encrypt with recipient's SSH public key
      finalContent = await encryptContent(content, to.publicKey);
      finalType = "encrypted";
    }

    // Sign the content (what gets sent, encrypted or not) with our private key
    let signature = "unsigned";
    const keyPath = fleetChatStore.getPrivateKeyPath() || PRIVATE_KEY_PATH;
    try {
      signature = await signContent(finalContent, keyPath);
    } catch (err) {
      console.warn("[fleet-chat] signing failed, sending unsigned:", (err as Error).message);
    }

    const timestamp = new Date().toISOString();

    // Build envelope
    const envelope = {
      id: undefined as string | undefined,
      from: localIdentity,
      to: { name: to.name, endpoint: to.endpoint, publicKey: to.publicKey },
      type: finalType,
      content: finalContent,
      timestamp,
      signature,
      metadata: input.metadata as Record<string, unknown> | undefined,
    };

    // Also store locally: find or create channel, record message
    let channel = fleetChatStore.findChannelByRemote(to.endpoint, to.publicKey);
    if (!channel) {
      channel = fleetChatStore.createChannel({ remoteFleet: to });
    }

    const localMsg = await fleetChatStore.sendMessage({
      channelId: channel.id,
      content: encrypt ? `[encrypted] ${content.substring(0, 50)}...` : content,
      type: type as any,
      metadata: {
        ...(input.metadata as Record<string, unknown> || {}),
        sentViaOutbox: true,
        encrypted: encrypt,
      },
    });

    envelope.id = localMsg.id;

    // Deliver to remote endpoint
    const inboxUrl = `${to.endpoint}/fleet-chat/inbox`;
    let deliveryResult: { ok: boolean; status?: number; error?: string };
    try {
      const resp = await fetch(inboxUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const respBody = await resp.json().catch(() => ({}));
      deliveryResult = { ok: resp.ok, status: resp.status, ...(respBody as object) };

      if (resp.ok) {
        fleetChatStore.updateDelivery(localMsg.id, "delivered");
      } else {
        fleetChatStore.updateDelivery(localMsg.id, "failed");
      }
    } catch (err) {
      deliveryResult = { ok: false, error: (err as Error).message };
      fleetChatStore.updateDelivery(localMsg.id, "failed");
    }

    emit("fleet-chat", "fleet-chat.message.sent", {
      messageId: localMsg.id,
      channelId: channel.id,
      to: to.name,
      encrypted: encrypt,
      delivered: deliveryResult.ok,
    }, localIdentity.name);

    return c.json({
      message: localMsg,
      delivery: deliveryResult,
      envelope: { id: envelope.id, type: envelope.type, signature: signature !== "unsigned" },
    }, deliveryResult.ok ? 200 : 502);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
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
fleetChatRoutes.post("/quarantine/:id/approve", async (c) => {
  try {
    const msg = await fleetChatStore.approveQuarantined(c.req.param("id"));
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
    const result = await fleetChatStore.receiveInbound(input as any);

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
