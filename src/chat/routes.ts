import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { WebChatStore, type ChatRole } from "./store.js";
import { ChatBridge, COMMANDS, parseCommand } from "./bridge.js";
import { emit } from "../events/emit.js";

// ── Singleton instances ────────────────────────────────────────────────────

export const webChatStore = new WebChatStore("data/web-chat.db");
export const chatStore = webChatStore;  // backward-compat alias
export const chatBridge = new ChatBridge(webChatStore);

// ── Routes ─────────────────────────────────────────────────────────────────

export const chatRoutes = new Hono();

// POST /messages — Post a message to chat
chatRoutes.post("/messages", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const input = body as Record<string, unknown>;
  const content = input.content as string;
  if (!content?.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  const role = (input.role as ChatRole) || "human";
  const sender = (input.sender as string) || "noah";

  // Parse command if present
  const parsed = parseCommand(content);

  const msg = webChatStore.post({
    role,
    sender,
    content: content.trim(),
    command: parsed?.name,
    metadata: input.metadata as Record<string, unknown> | undefined,
  });

  emit("chat", "chat.message.posted", {
    messageId: msg.id,
    role: msg.role,
    sender: msg.sender,
    command: msg.command,
    preview: msg.content.slice(0, 100),
  }, msg.sender);

  return c.json(msg, 201);
});

// GET /messages — List messages (supports polling with ?after=)
chatRoutes.get("/messages", (c) => {
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 100;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const role = c.req.query("role") as ChatRole | undefined;

  const messages = webChatStore.list({ limit, after, before, role });
  return c.json({ messages, count: messages.length });
});

// GET /messages/stream — SSE stream of new messages
chatRoutes.get("/messages/stream", (c) => {
  return streamSSE(c, async (stream) => {
    // Send recent history first
    const recent = webChatStore.list({ limit: 50 });
    for (const msg of recent) {
      await stream.writeSSE({
        data: JSON.stringify(msg),
        event: "message",
        id: msg.id,
      });
    }

    // Stream new messages
    const removeListener = webChatStore.addListener(async (msg) => {
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

    await new Promise<void>((resolve) => {
      stream.onAbort(resolve);
    });
  });
});

// GET /bridge/status — Bridge info and available commands
chatRoutes.get("/bridge/status", (c) => {
  return c.json({
    running: chatBridge.isRunning,
    commands: COMMANDS,
    messageCount: webChatStore.count,
    description: "Chat-to-action bridge. Post messages with / commands to execute fleet operations.",
  });
});

// ── Fleet event hook ───────────────────────────────────────────────────────
// Wire into the event system to auto-post fleet events to chat.

/**
 * Call this after server starts to hook fleet events into web chat.
 * Watches the event log for interesting events and posts them to chat.
 */
export function startFleetEventBridge(): void {
  // Dynamic import to avoid circular dependency at module load time
  let eventLogStore: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    eventLogStore = (globalThis as any).__eventLogStore;
  } catch {}

  // Fallback: import the store directly
  if (!eventLogStore) {
    import("../events/store.js").then((mod) => {
      (globalThis as any).__eventLogStore = mod.eventLogStore;
      // Restart after we have the store
      stopFleetEventBridge();
      startFleetEventBridgeWithStore(mod.eventLogStore);
    }).catch(() => {});
    return;
  }

  startFleetEventBridgeWithStore(eventLogStore);
}

function startFleetEventBridgeWithStore(eventLogStore: any): void {

  // Check for new events every 10 seconds
  let lastSeenId = eventLogStore.lastId?.() ?? 0;

  // Get current max ID to avoid replaying history
  try {
    const recent = eventLogStore.query({ limit: 1 });
    if (recent.length > 0 && recent[0].seq) {
      lastSeenId = recent[0].seq;
    }
  } catch { /* ignore */ }

  const INTERESTING_TYPES = new Set([
    "board.task.created",
    "board.task.updated",
    "registry.vm.registered",
    "registry.vm.stale",
    "fleet-chat.message.received",
    "deploy_started",
    "deploy_completed",
    "deploy_failed",
    "task_completed",
    "error",
    "agent_completed",
    "human_message",
  ]);

  const interval = setInterval(() => {
    try {
      const events = eventLogStore.query({ sinceId: lastSeenId, limit: 20 });
      for (const evt of events) {
        if (evt.seq) lastSeenId = Math.max(lastSeenId, evt.seq);

        // Skip our own events to avoid loops
        if (evt.source === "chat" || evt.agent === "chat-bridge") continue;

        // Only forward interesting events
        if (!INTERESTING_TYPES.has(evt.type)) continue;

        const summary = formatEventForChat(evt);
        if (summary) {
          chatBridge.postFleetEvent(summary, evt.source || "fleet", {
            eventType: evt.type,
            eventId: evt.id,
            agent: evt.agent,
          });
        }
      }
    } catch { /* ignore polling errors */ }
  }, 10_000);

  // Store interval for cleanup
  (startFleetEventBridge as any)._interval = interval;
}

export function stopFleetEventBridge(): void {
  const interval = (startFleetEventBridge as any)?._interval;
  if (interval) clearInterval(interval);
}

function formatEventForChat(evt: any): string | null {
  const agent = evt.agent || evt.source || "unknown";
  const payload = evt.payload || {};

  switch (evt.type) {
    case "board.task.created":
      return `📋 Task created: ${payload.title || payload.taskId || "?"} by @${agent}`;
    case "board.task.updated":
      return `📋 Task updated: ${payload.taskId || "?"} → ${payload.status || "?"}`;
    case "registry.vm.registered":
      return `🖥️ VM registered: ${payload.name || payload.vmId} [${payload.role}]`;
    case "registry.vm.stale":
      return `⚠️ Stale VM: ${payload.name || payload.vmId} [${payload.role}]`;
    case "fleet-chat.message.received":
      return `💬 Fleet message from ${payload.from || "?"}: type=${payload.type}`;
    case "deploy_started":
      return `🚀 Deploy started by @${agent}`;
    case "deploy_completed":
      return `✅ Deploy completed by @${agent}`;
    case "deploy_failed":
      return `❌ Deploy failed: ${payload.error || "unknown error"}`;
    case "task_completed":
      return `✅ @${agent}: ${evt.summary || payload.summary || "task completed"}`;
    case "error":
      return `❌ Error from @${agent}: ${evt.summary || payload.message || "?"}`;
    case "agent_completed":
      return `✅ Agent @${agent} completed work`;
    default:
      return null;
  }
}
