import { describe, it, expect, afterAll } from "vitest";
import { Hono } from "hono";
import { loopRoutes, loopStore } from "../routes.js";

const app = new Hono();
app.route("/loop", loopRoutes);

async function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return app.request(`http://localhost/loop${path}`, opts);
}

afterAll(() => {
  try { loopStore.stop(); } catch {}
});

describe("Loop Routes", () => {
  it("GET /status — returns loop status", async () => {
    const res = await req("GET", "/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.running).toBe(false);
    expect(data.roles).toHaveLength(4);
  });

  it("GET /config — returns role configs", async () => {
    const res = await req("GET", "/config");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.roles).toHaveLength(4);
    expect(data.roles[0].name).toBe("Sentinel");
  });

  it("PATCH /config/:name — updates role", async () => {
    const res = await req("PATCH", "/config/Sentinel", { intervalMs: 30000 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.intervalMs).toBe(30000);
  });

  it("PATCH /config/:name — 404 on unknown", async () => {
    const res = await req("PATCH", "/config/Unknown", { enabled: false });
    expect(res.status).toBe(404);
  });

  it("PATCH /config/:name — 400 on bad interval", async () => {
    const res = await req("PATCH", "/config/Sentinel", { intervalMs: 100 });
    expect(res.status).toBe(400);
  });

  it("POST /start — starts the loop", async () => {
    const res = await req("POST", "/start");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.running).toBe(true);
    expect(data.startedAt).toBeTruthy();
  });

  it("POST /start — 400 on double start", async () => {
    const res = await req("POST", "/start");
    expect(res.status).toBe(400);
  });

  it("GET /runs — returns run records", async () => {
    const res = await req("GET", "/runs");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs.length).toBeGreaterThan(0);
  });

  it("GET /runs?role=Sentinel — filters by role", async () => {
    const res = await req("GET", "/runs?role=Sentinel");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs.every((r: any) => r.role === "Sentinel")).toBe(true);
  });

  it("POST /stop — stops the loop", async () => {
    const res = await req("POST", "/stop");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.running).toBe(false);
  });

  it("POST /stop — 400 when already stopped", async () => {
    const res = await req("POST", "/stop");
    expect(res.status).toBe(400);
  });
});
