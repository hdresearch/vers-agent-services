import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { gossipRoutes, gossipStore } from "../routes.js";

const app = new Hono();
app.route("/gossip", gossipRoutes);

async function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return app.request(`http://localhost/gossip${path}`, opts);
}

describe("Gossip Routes", () => {
  it("POST /messages — sends a message", async () => {
    const res = await req("POST", "/messages", {
      from: "sentinel",
      to: "quartermaster",
      type: "request",
      subject: "Status check",
      body: "How is the queue?",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.from).toBe("sentinel");
  });

  it("POST /messages — 400 on missing fields", async () => {
    const res = await req("POST", "/messages", { from: "a" });
    expect(res.status).toBe(400);
  });

  it("GET /messages?to=quartermaster — returns inbox", async () => {
    const res = await req("GET", "/messages?to=quartermaster");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toBeDefined();
    expect(data.count).toBeGreaterThan(0);
  });

  it("GET /messages — 400 without to param", async () => {
    const res = await req("GET", "/messages");
    expect(res.status).toBe(400);
  });

  it("POST /broadcast — broadcasts to all", async () => {
    const res = await req("POST", "/broadcast", {
      from: "orchestrator",
      type: "inform",
      subject: "Deploy v3",
      body: "Rolling out now",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.to).toBe("*");
  });

  it("GET /activity — returns summary", async () => {
    const res = await req("GET", "/activity");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalMessages).toBeGreaterThan(0);
    expect(data.recentThreads).toBeDefined();
  });

  it("GET /threads/:id — returns thread", async () => {
    // Send a message, get its threadId
    const sendRes = await req("POST", "/messages", {
      from: "a",
      to: "b",
      type: "inform",
      subject: "thread test",
      body: "first",
    });
    const msg = await sendRes.json();

    const res = await req("GET", `/threads/${msg.threadId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toHaveLength(1);
  });

  it("GET /threads/:id — 404 on unknown", async () => {
    const res = await req("GET", "/threads/NONEXISTENT");
    expect(res.status).toBe(404);
  });

  it("POST /messages/:id/read — marks as read", async () => {
    const sendRes = await req("POST", "/messages", {
      from: "x",
      to: "y",
      type: "inform",
      subject: "read test",
      body: "mark me",
    });
    const msg = await sendRes.json();

    const res = await req("POST", `/messages/${msg.id}/read`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.readAt).toBeTruthy();
  });
});
