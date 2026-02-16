import { describe, it, expect, beforeEach } from "vitest";
import { DeployStore } from "../deploy/store.js";

describe("DeployStore", () => {
  let store: DeployStore;

  beforeEach(() => {
    const tmpFile = `/tmp/deploy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    store = new DeployStore(tmpFile);
  });

  describe("createRecord", () => {
    it("creates a deploy record with defaults", () => {
      const record = store.createRecord("main", "test-agent");

      expect(record.id).toBeTruthy();
      expect(record.id).toMatch(/^deploy-/);
      expect(record.branch).toBe("main");
      expect(record.triggeredBy).toBe("test-agent");
      expect(record.success).toBe(false);
      expect(record.completedAt).toBeNull();
      expect(record.commit).toBeNull();
      expect(record.previousCommit).toBeNull();
      expect(record.snapshotCommit).toBeNull();
      expect(record.error).toBeNull();
    });

    it("records appear in history newest-first", () => {
      store.createRecord("main", "agent-1");
      store.createRecord("feat/foo", "agent-2");

      const history = store.getHistory();
      expect(history.length).toBe(2);
      expect(history[0].branch).toBe("feat/foo");
      expect(history[1].branch).toBe("main");
    });
  });

  describe("updateRecord", () => {
    it("updates fields on an existing record", () => {
      const record = store.createRecord("main", "test");
      const updated = store.updateRecord(record.id, {
        success: true,
        commit: "abc123",
        previousCommit: "def456",
        completedAt: new Date().toISOString(),
      });

      expect(updated).not.toBeNull();
      expect(updated!.success).toBe(true);
      expect(updated!.commit).toBe("abc123");
      expect(updated!.previousCommit).toBe("def456");
    });

    it("returns null for unknown record", () => {
      const result = store.updateRecord("nonexistent", { success: true });
      expect(result).toBeNull();
    });
  });

  describe("getStatus", () => {
    it("returns empty status when no deploys", () => {
      const status = store.getStatus();
      expect(status.lastDeployTime).toBeNull();
      expect(status.currentCommit).toBeNull();
      expect(status.lastResult).toBeNull();
      expect(status.deploying).toBe(false);
    });

    it("shows deploying=true when last deploy has no completedAt", () => {
      store.createRecord("main", "agent");
      const status = store.getStatus();
      expect(status.deploying).toBe(true);
    });

    it("shows currentCommit from successful deploy", () => {
      const record = store.createRecord("main", "agent");
      store.updateRecord(record.id, {
        success: true,
        commit: "abc123",
        completedAt: new Date().toISOString(),
      });
      const status = store.getStatus();
      expect(status.currentCommit).toBe("abc123");
      expect(status.deploying).toBe(false);
    });
  });

  describe("getHistory", () => {
    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.createRecord("main", `agent-${i}`);
      }
      expect(store.getHistory(3).length).toBe(3);
      expect(store.getHistory(20).length).toBe(10);
    });

    it("trims to MAX_HISTORY (50)", () => {
      for (let i = 0; i < 60; i++) {
        store.createRecord("main", `agent-${i}`);
      }
      // Internal storage capped at 50
      expect(store.getHistory(100).length).toBe(50);
    });
  });
});
