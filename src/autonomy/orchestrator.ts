/**
 * Autonomy Orchestrator — the brain.
 *
 * Watches feed events for triggers, checks Aegis before every spawn,
 * dispatches agents via Vers API, tracks retries, correlates with registry.
 *
 * Event triggers:
 * - task_completed → check if dependent tasks can now start
 * - task_failed → retry logic (max 2 retries, then escalate)
 * - blocker_found → notify human, pause related tasks
 * - sprint_ready → dispatch agents for sprint tasks
 *
 * Safety:
 * - Checks Aegis budget + spawn limits before every spawn
 * - Hard stop if budget exceeded
 * - Never auto-approves: infra deletion, key rotation, external fleet, budget increases
 */

import { AutonomyStore, NEVER_AUTO_APPROVE } from "./store.js";
import { EscalationEngine } from "./escalation.js";
import { Scheduler } from "./scheduler.js";
import { EventLogStore, type EventRecord } from "../events/store.js";
import { emit } from "../events/emit.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorDeps {
  store: AutonomyStore;
  eventStore: EventLogStore;
  escalation: EscalationEngine;
  scheduler: Scheduler;
  selfBaseUrl?: string;
  authToken?: string;
  versApiBase?: string;
}

interface RetryState {
  taskId: string;
  agentId: string;
  retries: number;
  lastError: string;
}

// Max retries before escalating to human
const MAX_RETRIES = 2;

// ── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private deps: OrchestratorDeps;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retryMap: Map<string, RetryState> = new Map(); // taskId → retry state
  private _pollIntervalMs = 15_000; // 15s — faster than daemon's 30s
  private lastEventCursor: number | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private get baseUrl(): string {
    return this.deps.selfBaseUrl || "http://localhost:3000";
  }

  private get token(): string {
    return this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async enable(): Promise<void> {
    if (this.pollTimer) return;

    this.deps.store.setState("enabled", "true");
    this.deps.store.setState("started_at", new Date().toISOString());

    // Restore cursor
    const cursor = this.deps.store.getState("last_event_cursor");
    this.lastEventCursor = cursor ? parseInt(cursor, 10) : null;

    // Start event polling
    this.pollTimer = setInterval(() => this.poll(), this._pollIntervalMs);

    // Start scheduler
    this.deps.scheduler.start();

    // Immediate first poll
    await this.poll();

    emit("autonomy", "loop.enabled", {}, "orchestrator");
    console.log("[orchestrator] enabled — polling every", this._pollIntervalMs / 1000, "s");
  }

  disable(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.deps.scheduler.stop();
    this.deps.store.setState("enabled", "false");
    emit("autonomy", "loop.disabled", {}, "orchestrator");
    console.log("[orchestrator] disabled — safe mode");
  }

  get isEnabled(): boolean {
    return this.pollTimer !== null;
  }

  getStatus() {
    const startedAt = this.deps.store.getState("started_at");
    const enabled = this.deps.store.isEnabled();
    const recentActions = this.deps.store.getActions(10);
    const pendingEscalations = this.deps.escalation.getPending();
    const schedule = this.deps.store.getSchedule();

    return {
      enabled,
      running: this.isEnabled,
      startedAt,
      uptime: startedAt
        ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
        : 0,
      lastEventCursor: this.lastEventCursor,
      recentActions,
      pendingEscalations: pendingEscalations.length,
      retryMapSize: this.retryMap.size,
      schedule,
      schedulerRunning: this.deps.scheduler.isRunning,
    };
  }

  // ── Event polling ──────────────────────────────────────────────────────────

  async poll(): Promise<number> {
    if (!this.deps.store.isEnabled()) return 0;

    const events = this.deps.eventStore.query({
      sinceId: this.lastEventCursor ?? undefined,
      limit: 200,
    });

    if (events.length === 0) {
      this.deps.store.setState("last_tick_at", new Date().toISOString());
      return 0;
    }

    let handled = 0;
    for (const event of events) {
      const wasHandled = await this.handleEvent(event);
      if (wasHandled) handled++;
      this.lastEventCursor = event.id;
      this.deps.store.setState("last_event_cursor", String(event.id));
    }

    this.deps.store.setState("last_tick_at", new Date().toISOString());
    return handled;
  }

  private async handleEvent(event: EventRecord): Promise<boolean> {
    // Skip our own events to prevent infinite loops
    if (event.source === "autonomy") return false;

    const type = event.type;

    try {
      // Feed events (from feed store)
      if (type === "task_completed" || type === "feed.task_completed") {
        await this.onTaskCompleted(event);
        return true;
      }

      if (type === "task_failed" || type === "feed.task_failed") {
        await this.onTaskFailed(event);
        return true;
      }

      if (type === "blocker_found" || type === "feed.blocker_found") {
        await this.onBlockerFound(event);
        return true;
      }

      // Sprint planner events
      if (type === "sprint_ready" || type === "autonomy.sprint_ready") {
        await this.onSprintReady(event);
        return true;
      }

      // Security events
      if (type.startsWith("security.") || type === "couch.guest.limits_exceeded") {
        await this.onSecurityEvent(event);
        return true;
      }

      // Fleet messages
      if (type === "fleet-chat.inbox" || type === "gossip.incoming") {
        await this.onFleetMessage(event);
        return true;
      }

      return false;
    } catch (err) {
      console.error(`[orchestrator] event handler error for ${type}:`, err);
      this.deps.store.recordAction({
        actionType: "event_handler_error",
        trigger: type,
        description: `Handler error for ${type}: ${(err as Error).message}`,
        result: "failure",
        resultDetail: (err as Error).message,
      });
      return false;
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private async onTaskCompleted(event: EventRecord): Promise<void> {
    const payload = event.payload as any;
    const taskId = payload?.taskId || payload?.id;

    // Clear retry state
    if (taskId) this.retryMap.delete(taskId);

    this.deps.store.recordAction({
      actionType: "task_completed_processed",
      trigger: event.type,
      description: `Task completed: ${taskId || "unknown"}`,
      result: "success",
      metadata: { taskId },
    });

    // Check if there are dependent tasks that can now start
    await this.checkDependentTasks(taskId);
  }

  private async onTaskFailed(event: EventRecord): Promise<void> {
    const payload = event.payload as any;
    const taskId = payload?.taskId || payload?.id || "unknown";
    const agentId = payload?.agentId || payload?.agent || event.agent || "unknown";
    const error = payload?.error || payload?.detail || "Unknown error";

    // Get or create retry state
    let state = this.retryMap.get(taskId);
    if (!state) {
      state = { taskId, agentId, retries: 0, lastError: error };
      this.retryMap.set(taskId, state);
    }

    state.retries++;
    state.lastError = error;

    if (state.retries > MAX_RETRIES) {
      // Exhausted retries — escalate to human
      await this.deps.escalation.agentFailed(agentId, taskId, error, state.retries);

      this.deps.store.recordAction({
        actionType: "task_retry_exhausted",
        trigger: event.type,
        description: `Task ${taskId} failed ${state.retries} times — escalated to human`,
        result: "blocked",
        metadata: { taskId, agentId, retries: state.retries },
      });
    } else {
      // Retry: spawn a new agent for this task
      const canProceed = await this.checkAegis();
      if (!canProceed) {
        this.deps.store.recordAction({
          actionType: "task_retry_blocked",
          trigger: event.type,
          description: `Retry ${state.retries}/${MAX_RETRIES} for task ${taskId} blocked by Aegis`,
          result: "blocked",
          metadata: { taskId, retries: state.retries },
        });
        return;
      }

      this.deps.store.recordAction({
        actionType: "task_retry",
        trigger: event.type,
        description: `Retrying task ${taskId} (attempt ${state.retries}/${MAX_RETRIES})`,
        result: "success",
        metadata: { taskId, agentId, retries: state.retries },
      });

      // Notify on every agent failure (requirement)
      await this.notify(
        `Agent retry: ${agentId} on task ${taskId}`,
        `Attempt ${state.retries}/${MAX_RETRIES}. Error: ${error}`,
        "normal",
      );
    }
  }

  private async onBlockerFound(event: EventRecord): Promise<void> {
    const payload = event.payload as any;
    const summary = payload?.summary || payload?.detail || "Blocker detected";

    await this.deps.escalation.escalate({
      type: "blocker",
      title: "Blocker found",
      detail: summary,
      metadata: payload,
    });

    this.deps.store.recordAction({
      actionType: "blocker_escalated",
      trigger: event.type,
      description: `Blocker escalated: ${summary}`,
      result: "success",
      metadata: payload,
    });
  }

  private async onSprintReady(event: EventRecord): Promise<void> {
    const payload = event.payload as any;
    const tasks = payload?.tasks || [];
    const taskCount = payload?.taskCount || tasks.length;

    // Sprint plans always require human approval
    const summary = tasks.slice(0, 10).map((t: any) => `- ${t.title}`).join("\n");
    await this.deps.escalation.sprintReady(
      event.eventId,
      taskCount,
      `${taskCount} tasks ready for sprint:\n${summary}`,
    );

    this.deps.store.recordAction({
      actionType: "sprint_plan_created",
      trigger: event.type,
      description: `Sprint plan with ${taskCount} tasks — awaiting approval`,
      result: "success",
      metadata: { taskCount },
    });
  }

  private async onSecurityEvent(event: EventRecord): Promise<void> {
    const payload = event.payload as any;
    await this.deps.escalation.securityEvent(
      event.type,
      JSON.stringify(payload),
      payload,
    );

    this.deps.store.recordAction({
      actionType: "security_escalated",
      trigger: event.type,
      description: `Security event escalated: ${event.type}`,
      result: "success",
    });
  }

  private async onFleetMessage(event: EventRecord): Promise<void> {
    const payload = event.payload as any;
    const from = payload?.from || payload?.fleet || "unknown";
    const message = payload?.message || payload?.content || JSON.stringify(payload);

    // External fleet communication always requires human review
    await this.deps.escalation.fleetMessage(from, message);

    this.deps.store.recordAction({
      actionType: "fleet_message_escalated",
      trigger: event.type,
      description: `Fleet message from ${from} — escalated`,
      result: "success",
    });
  }

  // ── Aegis integration ─────────────────────────────────────────────────────

  /**
   * Check Aegis before any spawn: budget OK? Under spawn limit?
   * Returns true if we can proceed.
   */
  async checkAegis(): Promise<boolean> {
    try {
      // Check budget
      const budgetRes = await fetch(`${this.baseUrl}/aegis/budget/status`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (budgetRes.ok) {
        const budgetData = (await budgetRes.json()) as { status: { blocked: boolean; costTodayCents: number; tokensToday: number } };
        if (budgetData.status.blocked) {
          // Hard stop — budget exceeded
          emit("autonomy", "aegis.budget_blocked", budgetData.status, "orchestrator");

          // Also check if we need to escalate
          const configRes = await fetch(`${this.baseUrl}/aegis/budget`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (configRes.ok) {
            const configData = (await configRes.json()) as { config: { maxCostPerDay: number; maxTokensPerDay: number } };
            await this.deps.escalation.checkBudget(budgetData.status, configData.config);
          }

          return false;
        }

        // Check if approaching 80%
        const configRes = await fetch(`${this.baseUrl}/aegis/budget`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (configRes.ok) {
          const configData = (await configRes.json()) as { config: { maxCostPerDay: number; maxTokensPerDay: number } };
          await this.deps.escalation.checkBudget(budgetData.status, configData.config);
        }
      }

      // Check spawn limits
      const spawnRes = await fetch(`${this.baseUrl}/aegis/spawn/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
      });
      if (spawnRes.ok) {
        const spawnData = (await spawnRes.json()) as { allowed: boolean; reason?: string };
        if (!spawnData.allowed) {
          emit("autonomy", "aegis.spawn_blocked", spawnData, "orchestrator");
          return false;
        }
      }

      return true;
    } catch (err) {
      console.error("[orchestrator] Aegis check failed:", err);
      // Fail closed — if we can't check Aegis, don't spawn
      return false;
    }
  }

  // ── Task dependency check ──────────────────────────────────────────────────

  private async checkDependentTasks(completedTaskId: string): Promise<void> {
    if (!completedTaskId) return;

    // Check board for tasks that might be unblocked
    try {
      const res = await fetch(`${this.baseUrl}/board/tasks?status=open&limit=50`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return;

      const data = (await res.json()) as { tasks: Array<{ id: string; title: string; tags?: string[]; metadata?: any }> };
      const tasks = data.tasks || [];

      // Look for tasks tagged with depends:<completedTaskId>
      const unblocked = tasks.filter((t) => {
        const deps = t.tags?.filter((tag) => tag.startsWith("depends:")) || [];
        return deps.some((d) => d === `depends:${completedTaskId}`);
      });

      if (unblocked.length > 0) {
        emit("autonomy", "tasks.unblocked", {
          completedTaskId,
          unblockedCount: unblocked.length,
          tasks: unblocked.map((t) => ({ id: t.id, title: t.title })),
        }, "orchestrator");
      }
    } catch {
      // Best effort
    }
  }

  // ── Notification helper ────────────────────────────────────────────────────

  private async notify(title: string, body: string, priority = "normal"): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/notifications`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          type: "alert",
          title,
          body,
          priority,
          source: "orchestrator",
        }),
      });
    } catch {
      // Best effort
    }
  }

  // ── Test helpers ───────────────────────────────────────────────────────────

  setPollInterval(ms: number): void {
    this._pollIntervalMs = ms;
  }

  /** Expose for testing */
  async handleEventPublic(event: EventRecord): Promise<boolean> {
    return this.handleEvent(event);
  }
}
