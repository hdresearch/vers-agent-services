import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutonomyStore } from "../store.js";
import { EscalationEngine } from "../escalation.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "data/test-autonomy-escalation.db";

// Mock fetch for notification delivery
const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

describe("EscalationEngine", () => {
  let store: AutonomyStore;
  let engine: EscalationEngine;

  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    store = new AutonomyStore(TEST_DB);
    engine = new EscalationEngine({
      store,
      selfBaseUrl: "http://localhost:3000",
      authToken: "test-token",
    });
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockClear();
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
    vi.unstubAllGlobals();
  });

  it("creates an escalation and sends notification", async () => {
    const esc = await engine.escalate({
      type: "budget_warning",
      title: "Budget at 85%",
      detail: "Approaching limit",
    });

    expect(esc.id).toBeTruthy();
    expect(esc.status).toBe("pending");

    // Should have called fetch for notification
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/notifications",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("approves an escalation", async () => {
    const esc = await engine.escalate({
      type: "sprint_approval",
      title: "Sprint ready",
      detail: "10 tasks",
    });

    const approved = engine.approve(esc.id, "noah");
    expect(approved!.status).toBe("approved");
    expect(approved!.resolvedBy).toBe("noah");
  });

  it("rejects an escalation", async () => {
    const esc = await engine.escalate({
      type: "fleet_message",
      title: "Message from Joseph",
      detail: "Hey!",
    });

    const rejected = engine.reject(esc.id, "noah");
    expect(rejected!.status).toBe("rejected");
  });

  it("lists pending escalations", async () => {
    await engine.escalate({ type: "blocker", title: "Blocker 1", detail: "A" });
    await engine.escalate({ type: "blocker", title: "Blocker 2", detail: "B" });

    const pending = engine.getPending();
    expect(pending.length).toBe(2);
  });

  it("identifies never-auto-approve actions", () => {
    expect(engine.requiresApproval("infra_deletion")).toBe(true);
    expect(engine.requiresApproval("key_rotation")).toBe(true);
    expect(engine.requiresApproval("external_fleet_communication")).toBe(true);
    expect(engine.requiresApproval("budget_increase")).toBe(true);
    expect(engine.requiresApproval("spawn_agent")).toBe(false);
  });

  it("escalates budget warnings at 80% threshold", async () => {
    await engine.checkBudget(
      { costTodayCents: 4200, tokensToday: 10_000_000, blocked: false },
      { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 },
    );

    const pending = engine.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe("budget_warning");
    expect(pending[0].title).toContain("80%");
  });

  it("escalates blocked budget", async () => {
    await engine.checkBudget(
      { costTodayCents: 5500, tokensToday: 21_000_000, blocked: true },
      { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 },
    );

    const pending = engine.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].title).toContain("EXCEEDED");
  });

  it("does not escalate when budget is healthy", async () => {
    await engine.checkBudget(
      { costTodayCents: 1000, tokensToday: 5_000_000, blocked: false },
      { maxCostPerDay: 5000, maxTokensPerDay: 20_000_000 },
    );

    const pending = engine.getPending();
    expect(pending.length).toBe(0);
  });

  it("escalates agent failure", async () => {
    const esc = await engine.agentFailed("agent-1", "task-abc", "OOM killed", 3);
    expect(esc.type).toBe("agent_failure");
    expect(esc.title).toContain("agent-1");
    expect(esc.detail).toContain("task-abc");
  });

  it("escalates security events", async () => {
    const esc = await engine.securityEvent("unauthorized_access", "Unknown IP attempted login");
    expect(esc.type).toBe("security_event");
  });

  it("escalates sprint ready", async () => {
    const esc = await engine.sprintReady("sprint-1", 5, "5 tasks ready");
    expect(esc.type).toBe("sprint_approval");
    expect(esc.metadata?.taskCount).toBe(5);
  });

  it("escalates fleet messages", async () => {
    const esc = await engine.fleetMessage("joseph", "Hey, want to collaborate?");
    expect(esc.type).toBe("fleet_message");
    expect(esc.metadata?.fromFleet).toBe("joseph");
  });
});
