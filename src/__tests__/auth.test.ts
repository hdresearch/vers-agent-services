import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";

describe("bearerAuth middleware", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.VERS_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.VERS_AUTH_TOKEN = originalToken;
    } else {
      delete process.env.VERS_AUTH_TOKEN;
    }
  });

  function buildApp() {
    const app = new Hono();
    app.get("/health", (c) => c.json({ status: "ok" }));
    app.use("/*", bearerAuth());
    app.get("/protected", (c) => c.json({ data: "secret" }));
    app.post("/protected", async (c) => {
      const body = await c.req.json();
      return c.json(body);
    });
    return app;
  }

  describe("when VERS_AUTH_TOKEN is not set", () => {
    beforeEach(() => {
      delete process.env.VERS_AUTH_TOKEN;
    });

    it("allows unauthenticated requests (dev mode)", async () => {
      const app = buildApp();
      const res = await app.request("/protected");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBe("secret");
    });
  });

  describe("when VERS_AUTH_TOKEN is set", () => {
    const TEST_TOKEN = "test-secret-token-12345";

    beforeEach(() => {
      process.env.VERS_AUTH_TOKEN = TEST_TOKEN;
    });

    it("rejects requests with no Authorization header", async () => {
      const app = buildApp();
      const res = await app.request("/protected");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("missing");
    });

    it("rejects requests with wrong token", async () => {
      const app = buildApp();
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("invalid");
    });

    it("rejects requests with malformed Authorization header", async () => {
      const app = buildApp();
      const res = await app.request("/protected", {
        headers: { Authorization: "Basic abc123" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects requests with empty Bearer token", async () => {
      const app = buildApp();
      const res = await app.request("/protected", {
        headers: { Authorization: "Bearer " },
      });
      expect(res.status).toBe(401);
    });

    it("allows requests with correct token", async () => {
      const app = buildApp();
      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBe("secret");
    });

    it("allows POST requests with correct token", async () => {
      const app = buildApp();
      const res = await app.request("/protected", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hello).toBe("world");
    });

    it("health endpoint is NOT protected (mounted before middleware)", async () => {
      const app = buildApp();
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    });
  });
});
