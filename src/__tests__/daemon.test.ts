import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DaemonStore } from "../daemon/store.js";
import { DaemonEngine, type DaemonDeps } from "../daemon/engine.js";
import { EventLogStore } from "../events/store.js";
import { ConfigStore } from "../config/store.js";

function tmpPath(prefix: string) {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

// --- Store Tests ---

describe("DaemonStore", () => {
  let store: DaemonStore;

  beforeEach(() => {
    store = new DaemonStore(tmpPath("daemon-store"));
  });

  afterEach(() => {
    store.close();
  });

  it("initializes with default state", () => {
    const state = store.getState();
    expect(state.running).toBe(false);
    expect(state.lastEventCursor).toBe(0);
    expect(state.startedAt).toBeNull();
  });

  it("records and retrieves actions", () => {
    const action = store.recordAction({
      actionType: "spawn_agent",
      trigger: "quartermaster.unassigned_tasks",
      triggerEventId: "EVT001",
      description: "Spawning agent for task X",
      result: "pending",
    });

    expect(action.id).toBeTruthy();
    expect(action.actionType).toBe("spawn_agent");
    expect(action.result).toBe("pending");

    const actions = store.getActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].trigger).toBe("quartermaster.unassigned_tasks");
  });

  it("updates action result", () => {
    const action = store.recordAction({
      actionType: "kill_guest",
      trigger: "couch.guest.limits_exceeded",
      triggerEventId: "EVT002",
      description: "Killing guest VM",
    });

    store.updateActionResult(action.id, "success", "VM destroyed");
    const actions = store.getActions();
    expect(actions[0].result).toBe("success");
    expect(actions[0].resultDetail).toBe("VM destroyed");
  });

  it("persists state across reads", () => {
    store.setState("running", "true");
    store.setState("last_event_cursor", "42");

    const state = store.getState();
    expect(state.running).toBe(true);
    expect(state.lastEventCursor).toBe(42);
  });

  it("counts actions", () => {
    expect(store.getActionCount()).toBe(0);
    store.recordAction({
      actionType: "log_event",
      trigger: "test",
      triggerEventId: "X",
      description: "test",
    });
    store.recordAction({
      actionType: "alert",
      trigger: "test",
      triggerEventId: "Y",
      description: "test 2",
    });
    expect(store.getActionCount()).toBe(2);
  });
});

// --- Engine Tests ---

describe("DaemonEngine", () => {
  let eventStore: EventLogStore;
  let configStore: ConfigStore;
  let daemonStore: DaemonStore;
  let engine: DaemonEngine;

  beforeEach(() => {
    eventStore = new EventLogStore(tmpPath("events"));
    configStore = new ConfigStore(tmpPath("config"));
    daemonStore = new DaemonStore(tmpPath("daemon"));

    // Mock fetch globally
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ briefing: "test briefing" }),
      text: async () => "ok",
    });

    engine = new DaemonEngine({
      eventStore,
      configStore,
      daemonStore,
      selfBaseUrl: "http://localhost:9999",
      authToken: "test-token",
      versApiBase: "https://api.vers.sh/api/v1",
    });
  });

  afterEach(() => {
    if (engine.isRunning) engine.stop();
    eventStore.close();
    daemonStore.close();
  });

  it("starts and stops", async () => {
    expect(engine.isRunning).toBe(false);
    await engine.start();
    expect(engine.isRunning).toBe(true);
    engine.stop();
    expect(engine.isRunning).toBe(false);
  });

  it("reports status", async () => {
    const status = engine.getStatus();
    expect(status.running).toBe(false);
    expect(status.uptime).toBe(0);
    expect(status.totalActions).toBe(0);
  });

  it("polls events and advances cursor", async () => {
    // Insert some events that don't match any rule
    eventStore.append({
      source: "test",
      type: "some.random.event",
      payload: { foo: "bar" },
    });

    const count = await engine.poll();
    expect(count).toBe(0); // no matching rules
    // But cursor should advance
    const state = daemonStore.getState();
    expect(state.lastEventCursor).toBeGreaterThan(0);
  });

  it("handles quartermaster.unassigned_tasks with high-priority task", async () => {
    // Set up golden commit ID in config
    configStore.set("GOLDEN_COMMIT_ID", "test-golden-123", "config");

    // Mock Vers API to return a VM
    (global.fetch as any).mockImplementation(async (url: string, opts?: any) => {
      if (url.includes("/vm/from_commit")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ vm_id: "new-vm-abc" }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ briefing: "" }),
        text: async () => "ok",
      };
    });

    eventStore.append({
      source: "quartermaster",
      type: "quartermaster.unassigned_tasks",
      payload: {
        tasks: [{ id: "TASK001", title: "Fix the tests", score: 5 }],
      },
    });

    const count = await engine.poll();
    expect(count).toBe(1);

    const actions = daemonStore.getActions();
    const spawnAction = actions.find((a) => a.actionType === "spawn_agent");
    expect(spawnAction).toBeTruthy();
    expect(spawnAction!.description).toContain("Fix the tests");
  });

  it("skips low-priority unassigned tasks", async () => {
    eventStore.append({
      source: "quartermaster",
      type: "quartermaster.unassigned_tasks",
      payload: {
        tasks: [{ id: "TASK002", title: "Nice to have", score: 1 }],
      },
    });

    const count = await engine.poll();
    expect(count).toBe(1);

    const actions = daemonStore.getActions();
    expect(actions[0].actionType).toBe("log_event");
    expect(actions[0].description).toContain("skipping auto-spawn");
  });

  it("handles couch.invite.redeemed", async () => {
    eventStore.append({
      source: "couch",
      type: "couch.invite.redeemed",
      payload: { guestName: "Barton" },
    });

    const count = await engine.poll();
    expect(count).toBe(1);

    const actions = daemonStore.getActions();
    expect(actions[0].actionType).toBe("log_event");
    expect(actions[0].description).toContain("Barton");
  });

  it("handles couch.guest.limits_exceeded", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    });

    eventStore.append({
      source: "couch",
      type: "couch.guest.limits_exceeded",
      payload: { guest: "BadActor", vmId: "vm-to-kill" },
    });

    const count = await engine.poll();
    expect(count).toBe(1);

    const actions = daemonStore.getActions();
    const killAction = actions.find((a) => a.actionType === "kill_guest");
    expect(killAction).toBeTruthy();
    expect(killAction!.description).toContain("BadActor");
  });

  it("handles sentinel.unhealthy", async () => {
    eventStore.append({
      source: "sentinel",
      type: "sentinel.unhealthy",
      payload: { service: "gitea" },
    });

    const count = await engine.poll();
    expect(count).toBe(1);

    const actions = daemonStore.getActions();
    expect(actions[0].actionType).toBe("restart_service");
    expect(actions[0].description).toContain("gitea");
  });

  it("handles auditor.stale_tasks", async () => {
    eventStore.append({
      source: "auditor",
      type: "auditor.stale_tasks",
      payload: {
        tasks: [
          { id: "T1", title: "Old task", status: "open" },
          { id: "T2", title: "Stuck task", status: "in_progress" },
        ],
      },
    });

    const count = await engine.poll();
    expect(count).toBe(1);

    const actions = daemonStore.getActions();
    expect(actions).toHaveLength(2);
    const types = actions.map((a) => a.actionType).sort();
    expect(types).toContain("close_task");
    expect(types).toContain("reassign_task");
  });

  it("processes multiple events in sequence, advancing cursor", async () => {
    eventStore.append({
      source: "couch",
      type: "couch.invite.redeemed",
      payload: { guestName: "Alice" },
    });
    eventStore.append({
      source: "couch",
      type: "couch.invite.redeemed",
      payload: { guestName: "Bob" },
    });

    await engine.poll();
    const actions = daemonStore.getActions();
    expect(actions).toHaveLength(2);

    // Second poll should find nothing new
    const count2 = await engine.poll();
    expect(count2).toBe(0);
  });

  it("idempotent start — second start is no-op", async () => {
    await engine.start();
    await engine.start(); // should not throw
    expect(engine.isRunning).toBe(true);
    engine.stop();
  });

  it("idempotent stop — stop when not running is no-op", () => {
    engine.stop(); // should not throw
    expect(engine.isRunning).toBe(false);
  });
});
