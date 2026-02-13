import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ApiKeyStore, hashKey, generateKey } from "../keys.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "data/test-api-keys.db";

describe("ApiKeyStore", () => {
  let store: ApiKeyStore;

  beforeEach(() => {
    // Clean up any leftover test DB
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      if (existsSync(f)) unlinkSync(f);
    }
    store = new ApiKeyStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  describe("generateKey", () => {
    it("returns a key with vk_ prefix", () => {
      const key = generateKey();
      expect(key).toMatch(/^vk_[a-f0-9]{64}$/);
    });

    it("generates unique keys", () => {
      const keys = new Set(Array.from({ length: 10 }, () => generateKey()));
      expect(keys.size).toBe(10);
    });
  });

  describe("hashKey", () => {
    it("returns a hex string", () => {
      expect(hashKey("test")).toMatch(/^[a-f0-9]{64}$/);
    });

    it("is deterministic", () => {
      expect(hashKey("test")).toBe(hashKey("test"));
    });
  });

  describe("create", () => {
    it("creates a key and returns the raw key", () => {
      const result = store.create({ name: "test-agent" });
      expect(result.rawKey).toMatch(/^vk_/);
      expect(result.key.name).toBe("test-agent");
      expect(result.key.id).toBeTruthy();
      expect(result.key.created_at).toBeTruthy();
      expect(result.key.revoked_at).toBeNull();
      expect(result.key.scopes).toEqual([]);
      expect(result.key.key_prefix).toBe(result.rawKey.slice(0, 7));
    });

    it("stores scopes", () => {
      const result = store.create({ name: "scoped", scopes: ["read", "write"] });
      expect(result.key.scopes).toEqual(["read", "write"]);
    });
  });

  describe("verify", () => {
    it("returns the key for a valid raw key", () => {
      const { rawKey } = store.create({ name: "agent-1" });
      const verified = store.verify(rawKey);
      expect(verified).not.toBeNull();
      expect(verified!.name).toBe("agent-1");
    });

    it("returns null for an unknown key", () => {
      expect(store.verify("vk_nonexistent")).toBeNull();
    });

    it("returns null for a revoked key", () => {
      const { rawKey, key } = store.create({ name: "agent-revoked" });
      store.revoke(key.id);
      expect(store.verify(rawKey)).toBeNull();
    });
  });

  describe("list", () => {
    it("lists all keys", () => {
      store.create({ name: "first" });
      store.create({ name: "second" });
      const keys = store.list();
      expect(keys).toHaveLength(2);
      const names = keys.map((k) => k.name).sort();
      expect(names).toEqual(["first", "second"]);
    });

    it("includes revoked keys", () => {
      const { key } = store.create({ name: "to-revoke" });
      store.revoke(key.id);
      const keys = store.list();
      expect(keys).toHaveLength(1);
      expect(keys[0].revoked_at).not.toBeNull();
    });
  });

  describe("revoke", () => {
    it("revokes an existing key", () => {
      const { key } = store.create({ name: "doomed" });
      expect(store.revoke(key.id)).toBe(true);
      const updated = store.getById(key.id);
      expect(updated!.revoked_at).not.toBeNull();
    });

    it("returns false for unknown id", () => {
      expect(store.revoke("nonexistent")).toBe(false);
    });

    it("returns false if already revoked", () => {
      const { key } = store.create({ name: "double-revoke" });
      store.revoke(key.id);
      expect(store.revoke(key.id)).toBe(false);
    });
  });
});
