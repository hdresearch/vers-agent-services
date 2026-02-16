import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { RouterStore } from "../router/store.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DB_DIR = "data/test-router";
const TEST_DB = join(TEST_DB_DIR, "router.db");

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) rmSync(f);
  }
}

describe("RouterStore", () => {
  let store: RouterStore;

  beforeAll(() => {
    cleanup();
    store = new RouterStore(TEST_DB);
  });

  afterAll(() => {
    store.close();
    cleanup();
  });

  describe("providers", () => {
    it("seeds default providers", () => {
      const providers = store.getAllProviders();
      expect(providers.length).toBeGreaterThanOrEqual(2);
      expect(providers.find((p) => p.name === "anthropic")).toBeTruthy();
      expect(providers.find((p) => p.name === "openai")).toBeTruthy();
    });

    it("resolves claude models to anthropic", () => {
      const provider = store.resolveProvider("claude-sonnet-4-20250514");
      expect(provider).toBeTruthy();
      expect(provider!.name).toBe("anthropic");
    });

    it("resolves gpt models to openai", () => {
      const provider = store.resolveProvider("gpt-4o");
      expect(provider).toBeTruthy();
      expect(provider!.name).toBe("openai");
    });

    it("resolves o1/o3/o4 models to openai", () => {
      expect(store.resolveProvider("o1-preview")?.name).toBe("openai");
      expect(store.resolveProvider("o3-mini")?.name).toBe("openai");
      expect(store.resolveProvider("o4-mini")?.name).toBe("openai");
    });

    it("returns null for unknown models", () => {
      expect(store.resolveProvider("llama-70b")).toBeNull();
    });

    it("allows adding custom providers", () => {
      store.setProvider({
        name: "custom",
        baseUrl: "https://my-llm.example.com",
        apiKeyConfigKey: "CUSTOM_API_KEY",
        models: ["llama-", "mistral-"],
      });

      const provider = store.resolveProvider("llama-70b");
      expect(provider).toBeTruthy();
      expect(provider!.name).toBe("custom");
      expect(provider!.baseUrl).toBe("https://my-llm.example.com");
    });

    it("updates existing providers", () => {
      store.setProvider({
        name: "anthropic",
        baseUrl: "https://custom-anthropic-proxy.example.com",
        apiKeyConfigKey: "CUSTOM_ANTHROPIC_KEY",
        models: ["claude-"],
      });

      const provider = store.getProvider("anthropic");
      expect(provider).toBeTruthy();
      expect(provider!.baseUrl).toBe("https://custom-anthropic-proxy.example.com");

      // Restore original
      store.setProvider({
        name: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKeyConfigKey: "ANTHROPIC_API_KEY",
        models: ["claude-"],
        defaultHeaders: { "anthropic-version": "2023-06-01" },
      });
    });
  });

  describe("rate limits", () => {
    it("returns defaults for unknown agents", () => {
      const limit = store.getRateLimit("unknown-agent");
      expect(limit.requestsPerMinute).toBe(60);
      expect(limit.tokensPerMinute).toBe(1_000_000);
    });

    it("allows setting custom rate limits", () => {
      store.setRateLimit({
        agent: "heavy-agent",
        requestsPerMinute: 10,
        tokensPerMinute: 100_000,
      });

      const limit = store.getRateLimit("heavy-agent");
      expect(limit.requestsPerMinute).toBe(10);
      expect(limit.tokensPerMinute).toBe(100_000);
    });
  });

  describe("request logging", () => {
    it("logs requests and retrieves stats", () => {
      store.logRequest({
        agent: "agent-1",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        latencyMs: 1500,
        status: 200,
      });

      store.logRequest({
        agent: "agent-2",
        model: "gpt-4o",
        provider: "openai",
        inputTokens: 2000,
        outputTokens: 800,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 900,
        status: 200,
      });

      const stats = store.getRequestStats("1h");
      expect(stats.totalRequests).toBe(2);
      expect(stats.totalInputTokens).toBe(3000);
      expect(stats.totalOutputTokens).toBe(1300);
      expect(stats.byAgent["agent-1"].requests).toBe(1);
      expect(stats.byAgent["agent-2"].requests).toBe(1);
      expect(stats.byModel["claude-sonnet-4-20250514"].requests).toBe(1);
      expect(stats.byModel["gpt-4o"].requests).toBe(1);
    });

    it("prunes old logs", () => {
      // pruneOldLogs(-1) sets cutoff in the future, deleting everything
      const pruned = store.pruneOldLogs(-1);
      expect(pruned).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("Router Routes (integration)", () => {
  it("health endpoint returns provider status", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBeTruthy();
    expect(body.providers).toBeTruthy();
    expect(body.providers.anthropic).toBeTruthy();
    expect(body.providers.openai).toBeTruthy();
  });

  it("rejects requests without model", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("model is required");
  });

  it("rejects requests with unknown model", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama-70b", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("No provider configured");
  });

  it("rejects invalid JSON", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("lists providers", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/providers");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.providers.length).toBeGreaterThanOrEqual(2);
  });

  it("returns stats", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/stats");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect("totalRequests" in body).toBe(true);
    expect("byAgent" in body).toBe(true);
    expect("byModel" in body).toBe(true);
  });

  it("messages endpoint rejects without model", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(400);
  });
});
