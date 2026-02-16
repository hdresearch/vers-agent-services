import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutonomyStore } from "../store.js";
import { Scheduler } from "../scheduler.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "data/test-autonomy-scheduler.db";

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ vms: [], tasks: [] }),
});

describe("Scheduler", () => {
  let store: AutonomyStore;
  let scheduler: Scheduler;

  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    store = new AutonomyStore(TEST_DB);
    scheduler = new Scheduler({
      store,
      selfBaseUrl: "http://localhost:3000",
      authToken: "test-token",
    });
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    if (scheduler.isRunning) scheduler.stop();
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
    vi.unstubAllGlobals();
  });

  it("starts and stops", () => {
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("can run a task by name", async () => {
    await scheduler.runTask("health_check");

    // Should have called registry endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/registry/vms"),
      expect.any(Object),
    );

    // Should have marked the run
    const entry = store.getScheduleEntry("health_check");
    expect(entry!.lastRunAt).toBeTruthy();
  });

  it("runs health_check and detects stale VMs", async () => {
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        vms: [
          { id: "vm-1", name: "infra", address: "1.2.3.4", lastHeartbeat: staleTime },
          { id: "vm-2", name: "healthy", address: "5.6.7.8", lastHeartbeat: new Date().toISOString() },
        ],
      }),
    });

    await scheduler.runTask("health_check");
    // The task should complete without errors
    const entry = store.getScheduleEntry("health_check");
    expect(entry!.lastRunAt).toBeTruthy();
  });

  it("runs sprint_plan with open tasks", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tasks: [
          { id: "t1", title: "Build auth", priority: "high", tags: ["backend"] },
          { id: "t2", title: "Write tests", priority: "medium", tags: ["testing"] },
        ],
      }),
    });

    await scheduler.runTask("sprint_plan");
    const entry = store.getScheduleEntry("sprint_plan");
    expect(entry!.lastRunAt).toBeTruthy();
  });

  it("runs charon_reap", async () => {
    const deadTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/registry/vms") && !url.includes("DELETE")) {
        return {
          ok: true,
          json: async () => ({
            vms: [
              { id: "vm-dead", name: "dead-worker", lastHeartbeat: deadTime, role: "worker" },
            ],
          }),
        };
      }
      if (url.includes("/aegis/protected/check")) {
        return { ok: true, json: async () => ({ allowed: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    await scheduler.runTask("charon_reap");
    const entry = store.getScheduleEntry("charon_reap");
    expect(entry!.lastRunAt).toBeTruthy();
  });

  it("skips disabled entries", async () => {
    store.updateScheduleEntry("health_check", { enabled: false });

    await scheduler.runTask("health_check");
    // Should not call fetch because the entry is disabled
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("supports custom handlers", async () => {
    let called = false;
    scheduler.registerHandler("custom_task", async () => { called = true; });

    await scheduler.runTask("custom_task");
    expect(called).toBe(true);
  });

  it("reloads schedule after config change", () => {
    scheduler.start();
    store.updateScheduleEntry("health_check", { intervalMs: 120000 });
    scheduler.reload();
    expect(scheduler.isRunning).toBe(true);
  });
});
