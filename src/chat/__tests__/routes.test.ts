import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { WebChatStore } from "../store.js";
import { ChatBridge, COMMANDS } from "../bridge.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Build a minimal test app with just chat routes (no auth)
function createTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), "chat-routes-test-"));
  const store = new WebChatStore(join(tmpDir, "chat.db"));
  const bridge = new ChatBridge(store);

  const app = new Hono();

  // POST /messages
  app.post("/messages", async (c) => {
    const body = await c.req.json();
    if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);
    const msg = store.post({
      role: body.role || "human",
      sender: body.sender || "noah",
      content: body.content.trim(),
      command: body.command,
      metadata: body.metadata,
    });
    return c.json(msg, 201);
  });

  // GET /messages
  app.get("/messages", (c) => {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 100;
    const after = c.req.query("after") || undefined;
    const role = c.req.query("role") as any;
    const messages = store.list({ limit, after, role });
    return c.json({ messages, count: messages.length });
  });

  // GET /bridge/status
  app.get("/bridge/status", (c) => {
    return c.json({
      running: bridge.isRunning,
      commands: COMMANDS,
      messageCount: store.count,
    });
  });

  return { app, store, bridge, tmpDir };
}

describe("Chat Routes", () => {
  let app: Hono;
  let store: WebChatStore;
  let bridge: ChatBridge;
  let tmpDir: string;

  beforeAll(() => {
    ({ app, store, bridge, tmpDir } = createTestApp());
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /messages — creates a message", async () => {
    const res = await app.request("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello from test", sender: "testuser" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.content).toBe("hello from test");
    expect(data.sender).toBe("testuser");
    expect(data.role).toBe("human");
    expect(data.id).toBeTruthy();
  });

  it("POST /messages — rejects empty content", async () => {
    const res = await app.request("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /messages — lists messages", async () => {
    const res = await app.request("/messages");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.length).toBeGreaterThanOrEqual(1);
    expect(data.count).toBe(data.messages.length);
  });

  it("GET /messages?limit=1 — respects limit", async () => {
    // Add a second message
    await app.request("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "second message" }),
    });

    const res = await app.request("/messages?limit=1");
    const data = await res.json();
    expect(data.messages.length).toBe(1);
  });

  it("GET /messages?role=system — filters by role", async () => {
    await app.request("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "system msg", role: "system", sender: "bridge" }),
    });

    const res = await app.request("/messages?role=system");
    const data = await res.json();
    expect(data.messages.length).toBeGreaterThanOrEqual(1);
    expect(data.messages.every((m: any) => m.role === "system")).toBe(true);
  });

  it("GET /bridge/status — returns command list", async () => {
    const res = await app.request("/bridge/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commands.length).toBe(COMMANDS.length);
    expect(data.messageCount).toBeGreaterThanOrEqual(3);
    expect(typeof data.running).toBe("boolean");
  });
});
