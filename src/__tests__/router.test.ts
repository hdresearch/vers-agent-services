import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
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

  before(() => {
    cleanup();
    store = new RouterStore(TEST_DB);
  });

  after(() => {
    store.close();
    cleanup();
  });

  describe("providers", () => {
    it("seeds default providers", () => {
      const providers = store.getAllProviders();
      assert.ok(providers.length >= 2);
      assert.ok(providers.find((p) => p.name === "anthropic"));
      assert.ok(providers.find((p) => p.name === "openai"));
    });

    it("resolves claude models to anthropic", () => {
      const provider = store.resolveProvider("claude-sonnet-4-20250514");
      assert.ok(provider);
      assert.equal(provider.name, "anthropic");
    });

    it("resolves gpt models to openai", () => {
      const provider = store.resolveProvider("gpt-4o");
      assert.ok(provider);
      assert.equal(provider.name, "openai");
    });

    it("resolves o1/o3/o4 models to openai", () => {
      assert.equal(store.resolveProvider("o1-preview")?.name, "openai");
      assert.equal(store.resolveProvider("o3-mini")?.name, "openai");
      assert.equal(store.resolveProvider("o4-mini")?.name, "openai");
    });

    it("returns null for unknown models", () => {
      assert.equal(store.resolveProvider("llama-70b"), null);
    });

    it("allows adding custom providers", () => {
      store.setProvider({
        name: "custom",
        baseUrl: "https://my-llm.example.com",
        apiKeyConfigKey: "CUSTOM_API_KEY",
        models: ["llama-", "mistral-"],
      });

      const provider = store.resolveProvider("llama-70b");
      assert.ok(provider);
      assert.equal(provider.name, "custom");
      assert.equal(provider.baseUrl, "https://my-llm.example.com");
    });

    it("updates existing providers", () => {
      store.setProvider({
        name: "anthropic",
        baseUrl: "https://custom-anthropic-proxy.example.com",
        apiKeyConfigKey: "CUSTOM_ANTHROPIC_KEY",
        models: ["claude-"],
      });

      const provider = store.getProvider("anthropic");
      assert.ok(provider);
      assert.equal(provider.baseUrl, "https://custom-anthropic-proxy.example.com");

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
      assert.equal(limit.requestsPerMinute, 60);
      assert.equal(limit.tokensPerMinute, 1_000_000);
    });

    it("allows setting custom rate limits", () => {
      store.setRateLimit({
        agent: "heavy-agent",
        requestsPerMinute: 10,
        tokensPerMinute: 100_000,
      });

      const limit = store.getRateLimit("heavy-agent");
      assert.equal(limit.requestsPerMinute, 10);
      assert.equal(limit.tokensPerMinute, 100_000);
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
      assert.equal(stats.totalRequests, 2);
      assert.equal(stats.totalInputTokens, 3000);
      assert.equal(stats.totalOutputTokens, 1300);
      assert.equal(stats.byAgent["agent-1"].requests, 1);
      assert.equal(stats.byAgent["agent-2"].requests, 1);
      assert.equal(stats.byModel["claude-sonnet-4-20250514"].requests, 1);
      assert.equal(stats.byModel["gpt-4o"].requests, 1);
    });

    it("prunes old logs", () => {
      // pruneOldLogs(-1) sets cutoff in the future, deleting everything
      const pruned = store.pruneOldLogs(-1);
      assert.ok(pruned >= 2);
    });
  });
});

describe("Router Routes (integration)", () => {
  it("health endpoint returns provider status", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/health");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.status);
    assert.ok(body.providers);
    assert.ok(body.providers.anthropic);
    assert.ok(body.providers.openai);
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

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.message.includes("model is required"));
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

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.message.includes("No provider configured"));
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

    assert.equal(res.status, 400);
  });

  it("lists providers", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/providers");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.providers.length >= 2);
  });

  it("returns stats", async () => {
    const { routerRoutes } = await import("../router/routes.js");
    const app = new Hono();
    app.route("/v1", routerRoutes);

    const res = await app.request("/v1/stats");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok("totalRequests" in body);
    assert.ok("byAgent" in body);
    assert.ok("byModel" in body);
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

    assert.equal(res.status, 400);
  });
});
