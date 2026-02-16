import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AutonomyStore, NEVER_AUTO_APPROVE } from "../store.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "data/test-autonomy-store.db";

describe("AutonomyStore", () => {
  let store: AutonomyStore;

  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    store = new AutonomyStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  // ── State ──────────────────────────────────────────────────────────────────

  it("starts disabled by default", () => {
    expect(store.isEnabled()).toBe(false);
  });

  it("can enable/disable", () => {
    store.setState("enabled", "true");
    expect(store.isEnabled()).toBe(true);
    store.setState("enabled", "false");
    expect(store.isEnabled()).toBe(false);
  });

  // ── Escalations ────────────────────────────────────────────────────────────

  it("creates and retrieves escalations", () => {
    const esc = store.createEscalation({
      type: "budget_warning",
      title: "Budget at 85%",
      detail: "Approaching daily limit",
      metadata: { costRatio: 0.85 },
    });

    expect(esc.id).toBeTruthy();
    expect(esc.status).toBe("pending");

    const retrieved = store.getEscalation(esc.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.title).toBe("Budget at 85%");
    expect(retrieved!.metadata).toEqual({ costRatio: 0.85 });
  });

  it("lists pending escalations", () => {
    store.createEscalation({ type: "agent_failure", title: "Agent failed", detail: "Crash" });
    store.createEscalation({ type: "blocker", title: "Blocker found", detail: "Blocked" });

    const pending = store.getPendingEscalations();
    expect(pending.length).toBe(2);
  });

  it("resolves escalations", () => {
    const esc = store.createEscalation({ type: "sprint_approval", title: "Sprint ready", detail: "10 tasks" });

    const approved = store.resolveEscalation(esc.id, "approved", "noah");
    expect(approved!.status).toBe("approved");
    expect(approved!.resolvedBy).toBe("noah");

    // Should no longer appear in pending
    const pending = store.getPendingEscalations();
    expect(pending.length).toBe(0);
  });

  it("returns null when resolving non-existent escalation", () => {
    const result = store.resolveEscalation("nonexistent", "approved");
    expect(result).toBeNull();
  });

  // ── Actions ────────────────────────────────────────────────────────────────

  it("records and retrieves actions", () => {
    store.recordAction({
      actionType: "task_retry",
      trigger: "task_failed",
      description: "Retrying task abc",
      result: "success",
    });

    const actions = store.getActions(10);
    expect(actions.length).toBe(1);
    expect(actions[0].actionType).toBe("task_retry");
  });

  it("updates action results", () => {
    const action = store.recordAction({
      actionType: "spawn_agent",
      trigger: "sprint_ready",
      description: "Spawning agent",
      result: "pending",
    });

    store.updateActionResult(action.id, "success", "VM xyz spawned");
    const actions = store.getActions(1);
    expect(actions[0].result).toBe("success");
    expect(actions[0].resultDetail).toBe("VM xyz spawned");
  });

  // ── Schedule ───────────────────────────────────────────────────────────────

  it("has default schedule entries", () => {
    const schedule = store.getSchedule();
    expect(schedule.length).toBe(4);
    const names = schedule.map((s) => s.name);
    expect(names).toContain("health_check");
    expect(names).toContain("scribe_kb");
    expect(names).toContain("charon_reap");
    expect(names).toContain("sprint_plan");
  });

  it("updates schedule entries", () => {
    const updated = store.updateScheduleEntry("health_check", { intervalMs: 60000 });
    expect(updated!.intervalMs).toBe(60000);
  });

  it("marks schedule runs", () => {
    store.markScheduleRun("health_check");
    const entry = store.getScheduleEntry("health_check");
    expect(entry!.lastRunAt).toBeTruthy();
    expect(entry!.nextRunAt).toBeTruthy();
  });

  // ── Never auto-approve ────────────────────────────────────────────────────

  it("has the correct never-auto-approve list", () => {
    expect(NEVER_AUTO_APPROVE).toContain("infra_deletion");
    expect(NEVER_AUTO_APPROVE).toContain("key_rotation");
    expect(NEVER_AUTO_APPROVE).toContain("external_fleet_communication");
    expect(NEVER_AUTO_APPROVE).toContain("budget_increase");
  });
});
