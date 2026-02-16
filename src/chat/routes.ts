import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ChatStore } from "./store.js";
import { emit } from "../events/emit.js";

export const chatStore = new ChatStore("data/chat.db");

export const chatRoutes = new Hono();

// POST /messages — Send a message
chatRoutes.post("/messages", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sender, content, role, metadata } = body;
  if (!sender || typeof sender !== "string") {
    return c.json({ error: "sender is required" }, 400);
  }
  if (!content || typeof content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const msg = chatStore.addMessage({
    sender: sender.trim(),
    content: content.trim(),
    role: role || "user",
    metadata,
  });

  emit("chat", "chat.message", {
    messageId: msg.id,
    sender: msg.sender,
    role: msg.role,
  }, msg.sender);

  return c.json(msg, 201);
});

// GET /messages — List messages
chatRoutes.get("/messages", (c) => {
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 100;
  const since = c.req.query("since") || undefined;
  const before = c.req.query("before") || undefined;
  const sender = c.req.query("sender") || undefined;
  const role = c.req.query("role") as any || undefined;

  const messages = chatStore.getMessages({ limit, since, before, sender, role });
  return c.json({ messages, count: messages.length });
});

// GET /messages/stream — SSE stream of new messages
chatRoutes.get("/messages/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const removeListener = chatStore.addListener(async (msg) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify(msg),
          event: "message",
          id: msg.id,
        });
      } catch { /* stream closed */ }
    });

    // Keep alive every 15s
    const keepAlive = setInterval(async () => {
      try {
        await stream.writeSSE({ data: "", event: "ping" });
      } catch {
        clearInterval(keepAlive);
      }
    }, 15_000);

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

// GET /messages/:id — Get single message
chatRoutes.get("/messages/:id", (c) => {
  const msg = chatStore.getMessage(c.req.param("id"));
  if (!msg) return c.json({ error: "Message not found" }, 404);
  return c.json(msg);
});
