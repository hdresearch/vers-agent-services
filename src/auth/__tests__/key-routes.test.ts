import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { keyRoutes, setKeyStore, getKeyStore } from "../key-routes.js";
import { ApiKeyStore } from "../keys.js";
import { bearerAuth } from "../../auth.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "data/test-key-routes.db";

describe("key-routes", () => {
  let store: ApiKeyStore;
  let app: Hono;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.VERS_AUTH_TOKEN;
    // Dev mode — no env token required
    delete process.env.VERS_AUTH_TOKEN;

    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      if (existsSync(f)) unlinkSync(f);
    }
    store = new ApiKeyStore(TEST_DB);
    setKeyStore(store);

    app = new Hono();
    app.use("/auth/*", bearerAuth());
    app.route("/auth", keyRoutes);
  });

  afterEach(() => {
    store.close();
    if (originalToken !== undefined) {
      process.env.VERS_AUTH_TOKEN = originalToken;
    } else {
      delete process.env.VERS_AUTH_TOKEN;
    }
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  describe("POST /auth/keys", () => {
    it("creates a key and returns raw key", async () => {
      const res = await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "my-agent" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.rawKey).toMatch(/^vk_/);
      expect(body.key.name).toBe("my-agent");
      expect(body.warning).toBeTruthy();
    });

    it("accepts scopes", async () => {
      const res = await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "scoped-agent", scopes: ["read", "write"] }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.key.scopes).toEqual(["read", "write"]);
    });

    it("rejects missing name", async () => {
      const res = await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty name", async () => {
      const res = await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid scopes", async () => {
      const res = await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad", scopes: "not-array" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /auth/keys", () => {
    it("lists keys without raw values", async () => {
      await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "agent-1" }),
      });
      await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "agent-2" }),
      });

      const res = await app.request("/auth/keys");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toHaveLength(2);
      // Should NOT contain rawKey
      expect(body.keys[0]).not.toHaveProperty("rawKey");
    });
  });

  describe("DELETE /auth/keys/:id", () => {
    it("revokes a key", async () => {
      const createRes = await app.request("/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "to-revoke" }),
      });
      const { key } = await createRes.json();

      const res = await app.request(`/auth/keys/${key.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
    });

    it("returns 404 for unknown key", async () => {
      const res = await app.request("/auth/keys/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("auth with API keys", () => {
    it("allows access with a valid API key when VERS_AUTH_TOKEN is set", async () => {
      process.env.VERS_AUTH_TOKEN = "admin-token";

      // Create a key using admin token
      const createRes = await app.request("/auth/keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-token",
        },
        body: JSON.stringify({ name: "worker" }),
      });
      expect(createRes.status).toBe(201);
      const { rawKey } = await createRes.json();

      // Use the API key to access a protected route
      const protectedApp = new Hono();
      protectedApp.use("/*", bearerAuth());
      protectedApp.get("/test", (c) => c.json({ ok: true }));

      const res = await protectedApp.request("/test", {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(200);
    });

    it("rejects revoked API key", async () => {
      process.env.VERS_AUTH_TOKEN = "admin-token";

      const createRes = await app.request("/auth/keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-token",
        },
        body: JSON.stringify({ name: "soon-dead" }),
      });
      const { rawKey, key } = await createRes.json();

      // Revoke
      await app.request(`/auth/keys/${key.id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-token" },
      });

      // Try to use revoked key
      const protectedApp = new Hono();
      protectedApp.use("/*", bearerAuth());
      protectedApp.get("/test", (c) => c.json({ ok: true }));

      const res = await protectedApp.request("/test", {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(401);
    });
  });
});
