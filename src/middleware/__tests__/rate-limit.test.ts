import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "../rate-limit.js";

describe("rateLimit middleware", () => {
  let app: Hono;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildApp(opts: { windowMs: number; maxRequests: number }) {
    const a = new Hono();
    a.post("/test", rateLimit(opts), (c) => c.json({ ok: true }));
    a.get("/test", (c) => c.json({ ok: true })); // not rate limited
    return a;
  }

  function post(app: Hono, token?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return app.request("/test", { method: "POST", headers });
  }

  it("allows requests under the limit", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 3 });

    const r1 = await post(app, "tok1");
    expect(r1.status).toBe(200);
    expect(r1.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(r1.headers.get("X-RateLimit-Remaining")).toBe("2");

    const r2 = await post(app, "tok1");
    expect(r2.status).toBe(200);
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("1");

    const r3 = await post(app, "tok1");
    expect(r3.status).toBe(200);
    expect(r3.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("returns 429 when limit is exceeded", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 2 });

    await post(app, "tok1");
    await post(app, "tok1");

    const r3 = await post(app, "tok1");
    expect(r3.status).toBe(429);

    const body = await r3.json();
    expect(body.error).toBe("Too Many Requests");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(r3.headers.get("Retry-After")).toBeTruthy();
    expect(r3.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("tracks tokens independently", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 1 });

    const r1 = await post(app, "tokenA");
    expect(r1.status).toBe(200);

    // tokenA is now exhausted
    const r2 = await post(app, "tokenA");
    expect(r2.status).toBe(429);

    // tokenB should still be fine
    const r3 = await post(app, "tokenB");
    expect(r3.status).toBe(200);
  });

  it("resets after the window expires", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 1 });

    const r1 = await post(app, "tok1");
    expect(r1.status).toBe(200);

    const r2 = await post(app, "tok1");
    expect(r2.status).toBe(429);

    // Advance time past the window
    vi.advanceTimersByTime(61_000);

    const r3 = await post(app, "tok1");
    expect(r3.status).toBe(200);
  });

  it("uses sliding window — oldest request expires first", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 2 });

    // t=0: request 1
    await post(app, "tok1");

    // t=30s: request 2
    vi.advanceTimersByTime(30_000);
    await post(app, "tok1");

    // t=30s: limit reached
    const blocked = await post(app, "tok1");
    expect(blocked.status).toBe(429);

    // t=61s: request 1 expires, slot opens
    vi.advanceTimersByTime(31_000);
    const allowed = await post(app, "tok1");
    expect(allowed.status).toBe(200);
  });

  it("handles anonymous requests (no auth header)", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 1 });

    const r1 = await post(app); // no token
    expect(r1.status).toBe(200);

    const r2 = await post(app); // no token, same anonymous bucket
    expect(r2.status).toBe(429);
  });

  it("sets correct Retry-After value", async () => {
    app = buildApp({ windowMs: 60_000, maxRequests: 1 });

    await post(app, "tok1");

    vi.advanceTimersByTime(10_000); // 10s later

    const r = await post(app, "tok1");
    expect(r.status).toBe(429);

    const retryAfter = parseInt(r.headers.get("Retry-After")!, 10);
    // Should be ~50s (60s window - 10s elapsed), ceiling'd
    expect(retryAfter).toBe(50);
  });
});

describe("rate limiting integration with server routes", () => {
  it("does not apply to GET requests", async () => {
    const app = new Hono();
    app.post("/test", rateLimit({ windowMs: 60_000, maxRequests: 1 }), (c) =>
      c.json({ ok: true }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    // Exhaust POST limit
    await app.request("/test", { method: "POST" });
    const blocked = await app.request("/test", { method: "POST" });
    expect(blocked.status).toBe(429);

    // GET should still work
    const getRes = await app.request("/test", { method: "GET" });
    expect(getRes.status).toBe(200);
  });
});
