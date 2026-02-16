import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutonomyStore } from "../store.js";
import { EscalationEngine } from "../escalation.js";
import { Scheduler } from "../scheduler.js";
import { Orchestrator } from "../orchestrator.js";
import { EventLogStore, type EventRecord } from "../../events/store.js";
import { unlinkSync } from "node:fs";

const TEST_AUTONOMY_DB = "data/test-orchestrator-autonomy.db";
const TEST_EVENTS_DB = "data/test-orchestrator-events.db";

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({}),
  text: async () => "",
});

describe("Orchestrator", () => {
  let autonomyStore: AutonomyStore;
  let eventStore: EventLogStore;
  let escalation: EscalationEngine;
  let scheduler: Scheduler;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    try { unlinkSync(TEST_AUTONOMY_DB); } catch {}
    try { unlinkSync(TEST_EVENTS_DB); } catch {}

    autonomyStore = new AutonomyStore(TEST_AUTONOMY_DB);
    eventStore = new EventLogStore(TEST_EVENTS_DB);

    escalation = new EscalationEngine({
      store: autonomyStore,
      selfBaseUrl: "http://localhost:3000",
      authToken: "test-token",
    });

    scheduler = new Scheduler({
      store: autonomyStore,
      selfBaseUrl: "http://localhost:3000",
      authToken: "test-token",
    });

    orchestrator = new Orchestrator({
      store: autonomyStore,
      eventStore,
      escalation,
      scheduler,
      selfBaseUrl: "http://localhost:3000",
      authToken: "test-token",
    });

    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    if (orchestrator.isEnabled) orchestrator.disable();
    autonomyStore.close();
    eventStore.close();
    try { unlinkSync(TEST_AUTONOMY_DB); } catch {}
    try { unlinkSync(TEST_EVENTS_DB); } catch {}
    vi.unstubAllGlobals();
  });

  function makeEvent(type: string, payload: any = {}, source = "feed"): EventRecord {
    const record = eventStore.append({ source, type, payload, agent: "test-agent" });
    return record;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it("starts disabled", () => {
    expect(orchestrator.isEnabled).toBe(false);
  });

  it("can enable and disable", async () => {
    await orchestrator.enable();
    expect(orchestrator.isEnabled).toBe(true);
    expect(autonomyStore.isEnabled()).toBe(true);

    orchestrator.disable();
    expect(orchestrator.isEnabled).toBe(false);
    expect(autonomyStore.isEnabled()).toBe(false);
  });

  it("returns status", async () => {
    const status = orchestrator.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.recentActions).toEqual([]);
  });

  // ── Event handling ─────────────────────────────────────────────────────────

  it("handles task_completed events", async () => {
    // Mock the board fetch for dependent tasks check
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [] }),
    });

    const event = makeEvent("task_completed", { taskId: "task-123" });
    const handled = await orchestrator.handleEventPublic(event);

    expect(handled).toBe(true);
    const actions = autonomyStore.getActions(10);
    expect(actions.some((a) => a.actionType === "task_completed_processed")).toBe(true);
  });

  it("handles task_failed with retry logic", async () => {
    // First failure: mock Aegis checks to pass
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/aegis/budget/status")) {
        return { ok: true, json: async () => ({ status: { blocked: false, costTodayCents: 100, tokensToday: 1000 } }) };
      }
      if (url.includes("/aegis/budget")) {
        return { ok: true, json: async () => ({ config: { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 } }) };
      }
      if (url.includes("/aegis/spawn/check")) {
        return { ok: true, json: async () => ({ allowed: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const event1 = makeEvent("task_failed", { taskId: "task-fail", error: "OOM" });
    await orchestrator.handleEventPublic(event1);

    let actions = autonomyStore.getActions(10);
    expect(actions.some((a) => a.actionType === "task_retry")).toBe(true);

    // Second failure — still retrying
    const event2 = makeEvent("task_failed", { taskId: "task-fail", error: "OOM again" });
    await orchestrator.handleEventPublic(event2);

    // Third failure — should escalate (max retries = 2)
    const event3 = makeEvent("task_failed", { taskId: "task-fail", error: "OOM again again" });
    await orchestrator.handleEventPublic(event3);

    actions = autonomyStore.getActions(20);
    expect(actions.some((a) => a.actionType === "task_retry_exhausted")).toBe(true);

    // Should have created an escalation
    const pending = escalation.getPending();
    expect(pending.some((e) => e.type === "agent_failure")).toBe(true);
  });

  it("handles blocker_found by escalating", async () => {
    const event = makeEvent("blocker_found", { summary: "DB migration missing" });
    await orchestrator.handleEventPublic(event);

    const pending = escalation.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe("blocker");
  });

  it("handles sprint_ready by creating approval escalation", async () => {
    const event = makeEvent("sprint_ready", {
      taskCount: 5,
      tasks: [
        { id: "t1", title: "Build API" },
        { id: "t2", title: "Write tests" },
      ],
    });

    await orchestrator.handleEventPublic(event);

    const pending = escalation.getPending();
    expect(pending.some((e) => e.type === "sprint_approval")).toBe(true);
  });

  it("handles security events", async () => {
    const event = makeEvent("security.unauthorized_access", { ip: "1.2.3.4" });
    await orchestrator.handleEventPublic(event);

    const pending = escalation.getPending();
    expect(pending.some((e) => e.type === "security_event")).toBe(true);
  });

  it("handles fleet messages", async () => {
    const event = makeEvent("fleet-chat.inbox", { from: "joseph", message: "Hello!" });
    await orchestrator.handleEventPublic(event);

    const pending = escalation.getPending();
    expect(pending.some((e) => e.type === "fleet_message")).toBe(true);
  });

  it("skips its own events (source=autonomy)", async () => {
    const event = makeEvent("task_completed", { taskId: "task-123" }, "autonomy");
    const handled = await orchestrator.handleEventPublic(event);
    expect(handled).toBe(false);
  });

  // ── Aegis integration ─────────────────────────────────────────────────────

  it("blocks when Aegis budget is exceeded", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/aegis/budget/status")) {
        return { ok: true, json: async () => ({ status: { blocked: true, costTodayCents: 5500, tokensToday: 21_000_000 } }) };
      }
      if (url.includes("/aegis/budget")) {
        return { ok: true, json: async () => ({ config: { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 } }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const allowed = await orchestrator.checkAegis();
    expect(allowed).toBe(false);
  });

  it("blocks when Aegis spawn limit reached", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/aegis/budget/status")) {
        return { ok: true, json: async () => ({ status: { blocked: false, costTodayCents: 100, tokensToday: 1000 } }) };
      }
      if (url.includes("/aegis/budget")) {
        return { ok: true, json: async () => ({ config: { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 } }) };
      }
      if (url.includes("/aegis/spawn/check")) {
        return { ok: true, json: async () => ({ allowed: false, reason: "Max concurrent VMs reached" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const allowed = await orchestrator.checkAegis();
    expect(allowed).toBe(false);
  });

  it("allows when Aegis checks pass", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/aegis/budget/status")) {
        return { ok: true, json: async () => ({ status: { blocked: false, costTodayCents: 100, tokensToday: 1000 } }) };
      }
      if (url.includes("/aegis/budget")) {
        return { ok: true, json: async () => ({ config: { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 } }) };
      }
      if (url.includes("/aegis/spawn/check")) {
        return { ok: true, json: async () => ({ allowed: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const allowed = await orchestrator.checkAegis();
    expect(allowed).toBe(true);
  });

  it("fails closed when Aegis is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const allowed = await orchestrator.checkAegis();
    expect(allowed).toBe(false);
  });

  // ── Polling ────────────────────────────────────────────────────────────────

  it("polls events from event store", async () => {
    autonomyStore.setState("enabled", "true");

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [] }),
    });

    // Add some events
    makeEvent("task_completed", { taskId: "t1" });
    makeEvent("task_completed", { taskId: "t2" });

    const handled = await orchestrator.poll();
    expect(handled).toBe(2);
  });

  it("does not poll when disabled", async () => {
    makeEvent("task_completed", { taskId: "t1" });
    const handled = await orchestrator.poll();
    expect(handled).toBe(0);
  });
});
