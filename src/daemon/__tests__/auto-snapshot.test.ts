import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DaemonEngine, type DaemonDeps } from "../engine.js";
import { DaemonStore } from "../store.js";
import { EventLogStore } from "../../events/store.js";
import { ConfigStore } from "../../config/store.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "data/test-daemon-snapshot.db";
const TEST_CONFIG_DB = "data/test-daemon-snapshot-config.db";
const TEST_EVENTS_DB = "data/test-daemon-snapshot-events.db";

function cleanup() {
  for (const f of [TEST_DB, TEST_CONFIG_DB, TEST_EVENTS_DB]) {
    if (existsSync(f)) unlinkSync(f);
    if (existsSync(f + "-wal")) unlinkSync(f + "-wal");
    if (existsSync(f + "-shm")) unlinkSync(f + "-shm");
  }
}

describe("Auto-Snapshot", () => {
  let daemonStore: DaemonStore;
  let configStore: ConfigStore;
  let eventStore: EventLogStore;
  let engine: DaemonEngine;

  // Track fetch calls
  let fetchCalls: Array<{ url: string; method: string; body?: any; headers?: any }> = [];
  let fetchResponses: Map<string, { ok: boolean; status: number; body: any }> = new Map();

  beforeEach(() => {
    cleanup();
    daemonStore = new DaemonStore(TEST_DB);
    configStore = new ConfigStore(TEST_CONFIG_DB);
    eventStore = new EventLogStore(TEST_EVENTS_DB);

    // Set up config
    configStore.set("VERS_API_KEY", "test-api-key", "secret");
    configStore.set("INFRA_VM_ID", "test-vm-id-1234", "config");

    fetchCalls = [];
    fetchResponses = new Map();

    // Default: commit API returns success
    fetchResponses.set("commit", {
      ok: true,
      status: 200,
      body: { commit_id: "snap-abc-123" },
    });

    // Default: commits ledger POST succeeds
    fetchResponses.set("commits-post", {
      ok: true,
      status: 201,
      body: { id: "ledger-1" },
    });

    // Default: commits list returns empty (nothing to prune)
    fetchResponses.set("commits-list", {
      ok: true,
      status: 200,
      body: { commits: [], count: 0 },
    });

    // Default: feed POST succeeds
    fetchResponses.set("feed", {
      ok: true,
      status: 201,
      body: {},
    });

    // Mock global fetch
    vi.stubGlobal("fetch", async (url: string, opts?: any) => {
      const method = opts?.method || "GET";
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      fetchCalls.push({ url, method, body, headers: opts?.headers });

      // Route to appropriate mock response
      if (url.includes("/vm/") && url.includes("/commit")) {
        const r = fetchResponses.get("commit")!;
        return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
      }
      if (url.includes("/commits") && method === "POST") {
        const r = fetchResponses.get("commits-post")!;
        return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
      }
      if (url.includes("/commits") && method === "GET") {
        const r = fetchResponses.get("commits-list")!;
        return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
      }
      if (url.includes("/commits/") && method === "DELETE") {
        return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
      }
      if (url.includes("/feed/")) {
        const r = fetchResponses.get("feed")!;
        return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
      }
      // Fallback
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
    });

    const deps: DaemonDeps = {
      eventStore,
      configStore,
      daemonStore,
      selfBaseUrl: "http://localhost:3000",
      authToken: "test-token",
      versApiBase: "https://api.vers.sh/api/v1",
    };

    engine = new DaemonEngine(deps);
    // Don't start the engine (it would trigger polling/heartbeat)
  });

  afterEach(() => {
    if (engine.isRunning) engine.stop();
    daemonStore.close();
    configStore.close();
    eventStore.close();
    vi.restoreAllMocks();
    cleanup();
  });

  describe("performSnapshot", () => {
    it("should call Vers API to commit the VM", async () => {
      const commitId = await engine.performSnapshot("manual");

      expect(commitId).toBe("snap-abc-123");

      // Verify Vers API was called with correct URL
      const commitCall = fetchCalls.find((c) => c.url.includes("/vm/") && c.url.includes("/commit"));
      expect(commitCall).toBeDefined();
      expect(commitCall!.url).toBe("https://api.vers.sh/api/v1/vm/test-vm-id-1234/commit");
      expect(commitCall!.method).toBe("POST");
      expect(commitCall!.headers["X-API-Key"]).toBeDefined();
    });

    it("should record the snapshot in daemon actions", async () => {
      await engine.performSnapshot("manual");

      const actions = daemonStore.getActions(10);
      expect(actions.length).toBe(1);
      expect(actions[0].actionType).toBe("auto_snapshot");
      expect(actions[0].trigger).toBe("manual.snapshot");
      expect(actions[0].result).toBe("success");
      expect(actions[0].resultDetail).toContain("snap-abc-123");
    });

    it("should log to the commits ledger", async () => {
      await engine.performSnapshot("auto");

      const commitPost = fetchCalls.find(
        (c) => c.url.includes("/commits") && c.method === "POST" && !c.url.includes("/vm/"),
      );
      expect(commitPost).toBeDefined();
      expect(commitPost!.body.commitId).toBe("snap-abc-123");
      expect(commitPost!.body.vmId).toBe("test-vm-id-1234");
      expect(commitPost!.body.label).toBe("infra-snapshot-auto");
      expect(commitPost!.body.agent).toBe("fleet-daemon");
      expect(commitPost!.body.tags).toContain("auto-snapshot");
      expect(commitPost!.body.tags).toContain("auto");
      expect(commitPost!.body.tags).toContain("infra");
    });

    it("should emit a feed event on success", async () => {
      await engine.performSnapshot("manual");

      const feedCall = fetchCalls.find((c) => c.url.includes("/feed/"));
      expect(feedCall).toBeDefined();
      expect(feedCall!.body.summary).toContain("snap-abc-123");
      expect(feedCall!.body.summary).toContain("manual");
    });

    it("should throw and record failure when Vers API fails", async () => {
      fetchResponses.set("commit", {
        ok: false,
        status: 500,
        body: "internal error",
      });

      await expect(engine.performSnapshot("manual")).rejects.toThrow("Vers API commit failed 500");

      const actions = daemonStore.getActions(10);
      expect(actions[0].result).toBe("failure");
      expect(actions[0].resultDetail).toContain("Vers API commit failed");
    });

    it("should throw when VERS_API_KEY is not configured", async () => {
      configStore.delete("VERS_API_KEY");

      await expect(engine.performSnapshot("manual")).rejects.toThrow("VERS_API_KEY not configured");
    });

    it("should use default VM ID when INFRA_VM_ID not set", async () => {
      configStore.delete("INFRA_VM_ID");

      await engine.performSnapshot("manual");

      const commitCall = fetchCalls.find((c) => c.url.includes("/vm/") && c.url.includes("/commit"));
      expect(commitCall!.url).toContain("a9a83d7f-c092-404a-bf44-cf21b96a2170");
    });
  });

  describe("pruneSnapshotCommits", () => {
    it("should delete old commits beyond the max", async () => {
      // Return 12 commits — should delete the last 2
      const commits = Array.from({ length: 12 }, (_, i) => ({
        commitId: `commit-${i}`,
        vmId: "test-vm",
      }));
      fetchResponses.set("commits-list", {
        ok: true,
        status: 200,
        body: { commits, count: 12 },
      });

      await engine.performSnapshot("manual");

      const deleteCalls = fetchCalls.filter(
        (c) => c.url.includes("/commits/") && c.method === "DELETE",
      );
      expect(deleteCalls.length).toBe(2);
      expect(deleteCalls[0].url).toContain("commit-10");
      expect(deleteCalls[1].url).toContain("commit-11");
    });

    it("should not delete when under the limit", async () => {
      fetchResponses.set("commits-list", {
        ok: true,
        status: 200,
        body: { commits: [{ commitId: "c1" }], count: 1 },
      });

      await engine.performSnapshot("manual");

      const deleteCalls = fetchCalls.filter(
        (c) => c.url.includes("/commits/") && c.method === "DELETE",
      );
      expect(deleteCalls.length).toBe(0);
    });
  });

  describe("auto-snapshot config", () => {
    it("should respect AUTO_SNAPSHOT_ENABLED=false", () => {
      configStore.set("AUTO_SNAPSHOT_ENABLED", "false", "config");
      // Access private method via type assertion for testing
      const enabled = (engine as any).isAutoSnapshotEnabled();
      expect(enabled).toBe(false);
    });

    it("should respect AUTO_SNAPSHOT_ENABLED=true", () => {
      configStore.set("AUTO_SNAPSHOT_ENABLED", "true", "config");
      const enabled = (engine as any).isAutoSnapshotEnabled();
      expect(enabled).toBe(true);
    });

    it("should default to disabled when key not set", () => {
      const enabled = (engine as any).isAutoSnapshotEnabled();
      expect(enabled).toBe(false);
    });
  });

  describe("manual trigger via performSnapshot", () => {
    it("should differentiate auto vs manual in action trigger field", async () => {
      await engine.performSnapshot("auto");
      await engine.performSnapshot("manual");

      const actions = daemonStore.getActions(10);
      // newest first
      expect(actions[0].trigger).toBe("manual.snapshot");
      expect(actions[1].trigger).toBe("timer.auto_snapshot");
    });
  });
});
