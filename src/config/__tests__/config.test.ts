import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore, ValidationError, maskValue } from "../store.js";

// --- Store unit tests ---

describe("ConfigStore", () => {
  let store: ConfigStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
    store = new ConfigStore(join(tmpDir, "config.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("seeding", () => {
    it("pre-seeds default entries on first startup", () => {
      expect(store.size).toBeGreaterThanOrEqual(6);
      const entry = store.get("GIT_EDITOR");
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe("true");
      expect(entry!.type).toBe("config");
    });

    it("seeds ANTHROPIC_API_KEY as secret", () => {
      const entry = store.get("ANTHROPIC_API_KEY");
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("secret");
    });

    it("seeds GITHUB_TOKEN as secret", () => {
      const entry = store.get("GITHUB_TOKEN");
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("secret");
    });
  });

  describe("CRUD", () => {
    it("sets and gets a config entry", () => {
      const entry = store.set("MY_KEY", "my-value", "config");
      expect(entry.key).toBe("MY_KEY");
      expect(entry.value).toBe("my-value");
      expect(entry.type).toBe("config");
      expect(entry.updatedAt).toBeTruthy();

      const fetched = store.get("MY_KEY");
      expect(fetched).not.toBeNull();
      expect(fetched!.value).toBe("my-value");
    });

    it("sets and gets a secret entry", () => {
      store.set("API_KEY", "sk-ant-1234567890", "secret");
      const fetched = store.get("API_KEY");
      expect(fetched!.type).toBe("secret");
      expect(fetched!.value).toBe("sk-ant-1234567890");
    });

    it("updates existing entry", () => {
      store.set("KEY", "old", "config");
      store.set("KEY", "new", "secret");
      const fetched = store.get("KEY");
      expect(fetched!.value).toBe("new");
      expect(fetched!.type).toBe("secret");
    });

    it("deletes an entry", () => {
      store.set("TO_DELETE", "val", "config");
      expect(store.delete("TO_DELETE")).toBe(true);
      expect(store.get("TO_DELETE")).toBeNull();
    });

    it("returns false when deleting nonexistent key", () => {
      expect(store.delete("NONEXISTENT")).toBe(false);
    });

    it("returns null for nonexistent key", () => {
      expect(store.get("NOPE")).toBeNull();
    });
  });

  describe("validation", () => {
    it("rejects empty key", () => {
      expect(() => store.set("", "val", "config")).toThrow(ValidationError);
      expect(() => store.set("  ", "val", "config")).toThrow(ValidationError);
    });

    it("rejects invalid type", () => {
      expect(() => store.set("KEY", "val", "invalid" as any)).toThrow(ValidationError);
    });
  });

  describe("masking", () => {
    it("masks secret values", () => {
      store.set("SECRET", "sk-ant-abcdefghijk", "secret");
      const entry = store.get("SECRET")!;
      const masked = store.getMasked(entry);
      expect(masked.value).toBe("sk-ant***");
      expect(masked.key).toBe("SECRET");
      expect(masked.type).toBe("secret");
    });

    it("does not mask config values", () => {
      store.set("URL", "https://example.com", "config");
      const entry = store.get("URL")!;
      const masked = store.getMasked(entry);
      expect(masked.value).toBe("https://example.com");
    });

    it("masks short values", () => {
      expect(maskValue("abc")).toBe("***");
      expect(maskValue("")).toBe("***");
    });

    it("getAllMasked returns masked secrets", () => {
      store.set("VISIBLE", "hello", "config");
      store.set("HIDDEN", "super-secret-key", "secret");
      const all = store.getAllMasked();
      const visible = all.find((e) => e.key === "VISIBLE");
      const hidden = all.find((e) => e.key === "HIDDEN");
      expect(visible!.value).toBe("hello");
      expect(hidden!.value).toBe("super-***");
    });
  });

  describe("env export", () => {
    it("returns flat key-value object with full values", () => {
      store.set("MY_URL", "https://example.com", "config");
      store.set("MY_SECRET", "sk-1234567890", "secret");
      const env = store.getEnv();
      expect(env.MY_URL).toBe("https://example.com");
      expect(env.MY_SECRET).toBe("sk-1234567890");
    });

    it("includes seeded entries", () => {
      const env = store.getEnv();
      expect(env).toHaveProperty("GIT_EDITOR");
      expect(env.GIT_EDITOR).toBe("true");
    });
  });

  describe("getAll", () => {
    it("returns entries sorted by key", () => {
      store.set("ZZZ", "last", "config");
      store.set("AAA", "first", "config");
      const all = store.getAll();
      const keys = all.map((e) => e.key);
      expect(keys.indexOf("AAA")).toBeLessThan(keys.indexOf("ZZZ"));
    });
  });
});

// --- Route integration tests ---

describe("Config Routes", () => {
  let app: Hono;
  let tmpDir: string;
  let store: ConfigStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-route-test-"));
    store = new ConfigStore(join(tmpDir, "config.db"));

    // We need to create routes with our test store
    // Import Hono and create inline routes that use our test store
    app = new Hono();

    app.get("/config", (c) => {
      const entries = store.getAllMasked();
      return c.json({ entries, count: entries.length });
    });

    app.get("/config/env", (c) => {
      return c.json(store.getEnv());
    });

    app.get("/config/:key", (c) => {
      const key = c.req.param("key");
      const reveal = c.req.query("reveal") === "true";
      const entry = store.get(key);
      if (!entry) return c.json({ error: "not found" }, 404);
      if (reveal || entry.type === "config") return c.json(entry);
      return c.json(store.getMasked(entry));
    });

    app.put("/config/:key", async (c) => {
      const key = c.req.param("key");
      try {
        const body = await c.req.json();
        const entry = store.set(key, body.value, body.type || "config");
        return c.json(entry);
      } catch (e) {
        if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
        throw e;
      }
    });

    app.delete("/config/:key", (c) => {
      const key = c.req.param("key");
      const deleted = store.delete(key);
      if (!deleted) return c.json({ error: "not found" }, 404);
      return c.json({ deleted: true, key });
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const put = (key: string, body: any) => ({
    method: "PUT" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("GET /config — lists all entries masked", async () => {
    store.set("MY_SECRET", "sk-ant-abcdefghijk", "secret");
    const res = await app.request("/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    const secret = body.entries.find((e: any) => e.key === "MY_SECRET");
    expect(secret.value).toBe("sk-ant***");
  });

  it("GET /config/:key — returns masked secret", async () => {
    store.set("TOKEN", "super-secret-token-123", "secret");
    const res = await app.request("/config/TOKEN");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("super-***");
    expect(body.type).toBe("secret");
  });

  it("GET /config/:key?reveal=true — returns full secret", async () => {
    store.set("TOKEN", "super-secret-token-123", "secret");
    const res = await app.request("/config/TOKEN?reveal=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("super-secret-token-123");
  });

  it("GET /config/:key — returns config value unmasked", async () => {
    store.set("URL", "https://example.com", "config");
    const res = await app.request("/config/URL");
    const body = await res.json();
    expect(body.value).toBe("https://example.com");
  });

  it("GET /config/:key — 404 for nonexistent", async () => {
    const res = await app.request("/config/NOPE");
    expect(res.status).toBe(404);
  });

  it("PUT /config/:key — creates entry", async () => {
    const res = await app.request("/config/NEW_KEY", put("NEW_KEY", { value: "hello", type: "config" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("NEW_KEY");
    expect(body.value).toBe("hello");
  });

  it("PUT /config/:key — updates entry", async () => {
    store.set("EXISTING", "old", "config");
    const res = await app.request("/config/EXISTING", put("EXISTING", { value: "new", type: "secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("new");
    expect(body.type).toBe("secret");
  });

  it("PUT /config/:key — 400 on invalid type", async () => {
    const res = await app.request("/config/BAD", put("BAD", { value: "x", type: "invalid" }));
    expect(res.status).toBe(400);
  });

  it("DELETE /config/:key — deletes entry", async () => {
    store.set("TO_DELETE", "val", "config");
    const res = await app.request("/config/TO_DELETE", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("DELETE /config/:key — 404 for nonexistent", async () => {
    const res = await app.request("/config/NOPE", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /config/env — returns flat object with full values", async () => {
    store.set("SECRET_KEY", "full-value-here", "secret");
    store.set("PUBLIC_URL", "https://api.com", "config");
    const res = await app.request("/config/env");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.SECRET_KEY).toBe("full-value-here");
    expect(body.PUBLIC_URL).toBe("https://api.com");
  });
});
