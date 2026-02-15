import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

interface Notification {
  id: string;
  type: string; // attention, chat, alert, update, custom
  title: string;
  body: string;
  priority: string; // critical, high, normal, low
  source: string;
  read: boolean;
  dismissed: boolean;
  createdAt: string;
}

class NotificationStore {
  private notifications: Notification[] = [];
  private sseClients: Set<(data: string) => void> = new Set();
  private counter = 0;

  create(notif: Partial<Notification>): Notification {
    const id = `notif-${Date.now()}-${++this.counter}`;
    const full: Notification = {
      id,
      type: notif.type || "custom",
      title: notif.title || "Notification",
      body: notif.body || "",
      priority: notif.priority || "normal",
      source: notif.source || "unknown",
      read: false,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    this.notifications.unshift(full);
    // Keep last 500
    if (this.notifications.length > 500) {
      this.notifications = this.notifications.slice(0, 500);
    }
    // Push to SSE clients
    this.broadcast("notification", full);
    return full;
  }

  getPending(since?: string): { notifications: Notification[]; pendingTotal: number } {
    let pending = this.notifications.filter((n) => !n.dismissed);
    if (since) {
      pending = pending.filter((n) => n.createdAt > since);
    }
    return {
      notifications: pending.slice(0, 50),
      pendingTotal: pending.filter((n) => !n.read).length,
    };
  }

  markRead(id: string): Notification | null {
    const n = this.notifications.find((n) => n.id === id);
    if (n) n.read = true;
    return n || null;
  }

  markAllRead(): number {
    let count = 0;
    for (const n of this.notifications) {
      if (!n.read) { n.read = true; count++; }
    }
    return count;
  }

  dismiss(id: string): Notification | null {
    const n = this.notifications.find((n) => n.id === id);
    if (n) { n.dismissed = true; n.read = true; }
    return n || null;
  }

  dismissAll(): number {
    let count = 0;
    for (const n of this.notifications) {
      if (!n.dismissed) { n.dismissed = true; n.read = true; count++; }
    }
    return count;
  }

  addClient(send: (data: string) => void) {
    this.sseClients.add(send);
  }

  removeClient(send: (data: string) => void) {
    this.sseClients.delete(send);
  }

  private broadcast(event: string, data: any) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    Array.from(this.sseClients).forEach((send) => {
      try { send(msg); } catch {}
    });
  }
}

export const notificationStore = new NotificationStore();
export const notificationRoutes = new Hono();

// Create notification
notificationRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const notif = notificationStore.create(body);
  return c.json(notif, 201);
});

// Get pending notifications
notificationRoutes.get("/pending", (c) => {
  const since = c.req.query("since") || undefined;
  return c.json(notificationStore.getPending(since));
});

// SSE stream
notificationRoutes.get("/stream", (c) => {
  const pending = notificationStore.getPending();

  return streamSSE(c, async (stream) => {
    // Send connected event
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ pendingCount: pending.pendingTotal }),
    });

    // Register for push
    const send = (data: string) => {
      stream.write(data).catch(() => {});
    };
    notificationStore.addClient(send);

    // Heartbeat
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => {});
    }, 15000);

    // Wait for disconnect
    try {
      await new Promise((resolve) => {
        c.req.raw.signal.addEventListener("abort", resolve);
      });
    } finally {
      clearInterval(heartbeat);
      notificationStore.removeClient(send);
    }
  });
});

// Mark notification as read
notificationRoutes.post("/:id/read", (c) => {
  const n = notificationStore.markRead(c.req.param("id"));
  if (!n) return c.json({ error: "not found" }, 404);
  return c.json(n);
});

// Mark all as read
notificationRoutes.post("/read-all", (c) => {
  const count = notificationStore.markAllRead();
  return c.json({ markedRead: count });
});

// Dismiss notification
notificationRoutes.post("/:id/dismiss", (c) => {
  const n = notificationStore.dismiss(c.req.param("id"));
  if (!n) return c.json({ error: "not found" }, 404);
  return c.json(n);
});

// Dismiss all
notificationRoutes.post("/dismiss-all", (c) => {
  const count = notificationStore.dismissAll();
  return c.json({ dismissed: count });
});

