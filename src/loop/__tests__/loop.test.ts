import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LoopStore } from "../store.js";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";

const TEST_FILE = "data/test-loop.json";

function cleanup() {
  for (const f of [TEST_FILE, TEST_FILE + ".tmp"]) {
    try { unlinkSync(f); } catch {}
  }
}

describe("LoopStore", () => {
  let store: LoopStore;
  let tickLog: string[];

  beforeEach(() => {
    cleanup();
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    tickLog = [];
    store = new LoopStore(TEST_FILE, (role) => {
      tickLog.push(role.name);
    });
  });

  afterEach(() => {
    // Stop loop if running to clear timers
    try { store.stop(); } catch {}
    cleanup();
  });

  describe("getStatus", () => {
    it("returns initial status with 4 roles", () => {
      const status = store.getStatus();
      expect(status.running).toBe(false);
      expect(status.roles).toHaveLength(4);
      expect(status.roles.map((r) => r.name)).toEqual(["Sentinel", "Quartermaster", "Scribe", "Auditor"]);
    });
  });

  describe("start/stop", () => {
    it("starts the loop and runs all enabled roles", () => {
      const status = store.start();
      expect(status.running).toBe(true);
      expect(status.startedAt).toBeTruthy();

      // All 4 roles should have ticked immediately
      expect(tickLog).toEqual(["Sentinel", "Quartermaster", "Scribe", "Auditor"]);
    });

    it("stops the loop", () => {
      store.start();
      const status = store.stop();
      expect(status.running).toBe(false);
    });

    it("errors on double start", () => {
      store.start();
      expect(() => store.start()).toThrow("already running");
    });

    it("errors on stop when not running", () => {
      expect(() => store.stop()).toThrow("not running");
    });
  });

  describe("config", () => {
    it("returns all role configs", () => {
      const config = store.getConfig();
      expect(config).toHaveLength(4);

      const sentinel = config.find((r) => r.name === "Sentinel")!;
      expect(sentinel.intervalMs).toBe(15 * 60 * 1000);
      expect(sentinel.enabled).toBe(true);
      expect(sentinel.task).toBe("health");
    });

    it("patches a role config", () => {
      const updated = store.patchConfig("Sentinel", { intervalMs: 30000, enabled: false });
      expect(updated.intervalMs).toBe(30000);
      expect(updated.enabled).toBe(false);
    });

    it("rejects too-small interval", () => {
      expect(() => store.patchConfig("Sentinel", { intervalMs: 100 })).toThrow("intervalMs must be >= 10000");
    });

    it("errors on unknown role", () => {
      expect(() => store.patchConfig("Unknown", { enabled: false })).toThrow("not found");
    });
  });

  describe("disabled roles", () => {
    it("skips disabled roles on start", () => {
      store.patchConfig("Scribe", { enabled: false });
      store.patchConfig("Auditor", { enabled: false });
      store.start();
      expect(tickLog).toEqual(["Sentinel", "Quartermaster"]);
    });
  });

  describe("runs", () => {
    it("records run history", () => {
      store.start();
      const runs = store.getRuns();
      expect(runs.length).toBe(4); // one per role
      expect(runs.every((r) => r.result === "success")).toBe(true);
    });

    it("filters by role name", () => {
      store.start();
      const runs = store.getRuns("Sentinel");
      expect(runs).toHaveLength(1);
      expect(runs[0].role).toBe("Sentinel");
    });
  });

  describe("error handling in tick", () => {
    it("records error result when tick throws", () => {
      const errorStore = new LoopStore(TEST_FILE + ".err", (role) => {
        if (role.name === "Sentinel") throw new Error("health check failed");
      });
      errorStore.start();
      const runs = errorStore.getRuns("Sentinel");
      expect(runs[0].result).toBe("error");
      expect(runs[0].detail).toContain("health check failed");
      errorStore.stop();
      try { unlinkSync(TEST_FILE + ".err"); } catch {}
    });
  });

  describe("persistence", () => {
    it("survives reload", () => {
      store.patchConfig("Sentinel", { intervalMs: 60000 });

      const store2 = new LoopStore(TEST_FILE);
      const sentinel = store2.getConfig().find((r) => r.name === "Sentinel")!;
      expect(sentinel.intervalMs).toBe(60000);
    });
  });

  describe("shutdown", () => {
    it("waits for active ticks to drain before resolving", async () => {
      let resolveSlowTick!: () => void;
      const slowTickPromise = new Promise<void>((resolve) => { resolveSlowTick = resolve; });
      const slowStore = new LoopStore(TEST_FILE + ".shutdown", async (role) => {
        if (role.name === "Sentinel") await slowTickPromise;
      });

      slowStore.start();
      expect(slowStore.activeTickCount).toBeGreaterThan(0);

      // Start shutdown — should not resolve yet because Sentinel tick is still running
      let shutdownDone = false;
      const shutdownPromise = slowStore.shutdown().then(() => { shutdownDone = true; });

      // Give microtasks a chance to run
      await new Promise((r) => setTimeout(r, 50));
      expect(shutdownDone).toBe(false);

      // Release the slow tick
      resolveSlowTick();
      await shutdownPromise;
      expect(shutdownDone).toBe(true);
      expect(slowStore.isRunning).toBe(false);
      expect(slowStore.activeTickCount).toBe(0);

      try { unlinkSync(TEST_FILE + ".shutdown"); } catch {}
    });

    it("does not fire new ticks after shutdown starts", async () => {
      vi.useFakeTimers();
      const ticks: string[] = [];
      const fastStore = new LoopStore(TEST_FILE + ".notick", (role) => {
        ticks.push(role.name);
      });

      fastStore.start();
      const initialTicks = ticks.length;

      // Begin shutdown (clears timers)
      const p = fastStore.shutdown();

      // Advance time well past any interval — no new ticks should fire
      vi.advanceTimersByTime(60 * 60 * 1000);
      await p;
      expect(ticks.length).toBe(initialTicks);

      vi.useRealTimers();
      try { unlinkSync(TEST_FILE + ".notick"); } catch {}
    });
  });
});
