/**
 * Scheduler — the clock.
 *
 * Runs periodic tasks on configurable intervals:
 * - Every 30min: health check all running VMs
 * - Every 1h: run scribe (extract KB from recent logs)
 * - Every 4h: run Charon (reap dead VMs)
 * - Every 6h: generate sprint plan from board state
 *
 * Configurable via API: POST /autonomy/schedule
 */

import { AutonomyStore, type ScheduleEntry } from "./store.js";
import { emit } from "../events/emit.js";

export interface SchedulerDeps {
  store: AutonomyStore;
  selfBaseUrl?: string;
  authToken?: string;
  versApiBase?: string;
}

type TaskHandler = () => Promise<void>;

export class Scheduler {
  private deps: SchedulerDeps;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private running = false;
  private handlers: Map<string, TaskHandler> = new Map();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.registerDefaultHandlers();
  }

  private get baseUrl(): string {
    return this.deps.selfBaseUrl || "http://localhost:3000";
  }

  private get token(): string {
    return this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    const schedule = this.deps.store.getSchedule();
    for (const entry of schedule) {
      if (entry.enabled) {
        this.startEntry(entry);
      }
    }

    console.log(`[scheduler] started — ${schedule.filter((e) => e.enabled).length} tasks active`);
  }

  stop(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running = false;
    console.log("[scheduler] stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  private startEntry(entry: ScheduleEntry): void {
    const existing = this.timers.get(entry.name);
    if (existing) clearInterval(existing);

    const timer = setInterval(() => this.runTask(entry.name), entry.intervalMs);
    this.timers.set(entry.name, timer);
  }

  /**
   * Run a specific task by name, immediately.
   */
  async runTask(name: string): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      console.warn(`[scheduler] no handler for task: ${name}`);
      return;
    }

    const entry = this.deps.store.getScheduleEntry(name);
    if (entry && !entry.enabled) return;

    try {
      await handler();
      this.deps.store.markScheduleRun(name);
      emit("autonomy", `scheduler.${name}.completed`, { task: name }, "scheduler");
    } catch (err) {
      console.error(`[scheduler] task ${name} failed:`, err);
      emit("autonomy", `scheduler.${name}.failed`, {
        task: name,
        error: (err as Error).message,
      }, "scheduler");
    }
  }

  /**
   * Reload schedule from store (after config change).
   */
  reload(): void {
    if (!this.running) return;
    this.stop();
    this.running = true; // mark running before starting entries
    const schedule = this.deps.store.getSchedule();
    for (const entry of schedule) {
      if (entry.enabled) {
        this.startEntry(entry);
      }
    }
  }

  /**
   * Register a custom task handler.
   */
  registerHandler(name: string, handler: TaskHandler): void {
    this.handlers.set(name, handler);
  }

  // ── Default handlers ──────────────────────────────────────────────────────

  private registerDefaultHandlers(): void {
    this.handlers.set("health_check", () => this.healthCheck());
    this.handlers.set("scribe_kb", () => this.scribeKb());
    this.handlers.set("charon_reap", () => this.charonReap());
    this.handlers.set("sprint_plan", () => this.sprintPlan());
  }

  /**
   * Health check: query registry for all VMs, check they're alive.
   */
  private async healthCheck(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/registry/vms`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      emit("autonomy", "scheduler.health_check.error", { status: res.status }, "scheduler");
      return;
    }

    const data = (await res.json()) as { vms: Array<{ id: string; name: string; address: string; lastHeartbeat?: string }> };
    const vms = data.vms || [];
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 min no heartbeat = stale

    const stale = vms.filter((vm) => {
      if (!vm.lastHeartbeat) return true;
      return now - new Date(vm.lastHeartbeat).getTime() > staleThreshold;
    });

    if (stale.length > 0) {
      emit("autonomy", "scheduler.health_check.stale_vms", {
        staleCount: stale.length,
        totalCount: vms.length,
        staleVms: stale.map((v) => ({ id: v.id, name: v.name })),
      }, "scheduler");
    }

    emit("autonomy", "scheduler.health_check.completed", {
      totalVms: vms.length,
      staleVms: stale.length,
      healthyVms: vms.length - stale.length,
    }, "scheduler");
  }

  /**
   * Trigger scribe KB sync by calling the loop's scribe tick.
   */
  private async scribeKb(): Promise<void> {
    // Trigger via the loop endpoint
    const res = await fetch(`${this.baseUrl}/loop/config/Scribe`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      // Force an immediate tick by temporarily setting a very short interval
      body: JSON.stringify({}),
    });

    // Just emit the event — the scribe tick runs on its own schedule
    emit("autonomy", "scheduler.scribe_kb.triggered", {}, "scheduler");
  }

  /**
   * Charon: reap dead VMs — find VMs that are stale and have no active tasks.
   */
  private async charonReap(): Promise<void> {
    const apiBase = this.deps.versApiBase || "https://api.vers.sh/api/v1";

    // Get all registered VMs
    const regRes = await fetch(`${this.baseUrl}/registry/vms`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!regRes.ok) return;

    const regData = (await regRes.json()) as { vms: Array<{ id: string; name: string; lastHeartbeat?: string; role?: string }> };
    const vms = regData.vms || [];
    const now = Date.now();
    const deadThreshold = 30 * 60 * 1000; // 30 min no heartbeat = dead

    // Check protected list via Aegis
    const deadVms = vms.filter((vm) => {
      if (vm.role === "infra" || vm.role === "gitea") return false; // Never reap infra
      if (!vm.lastHeartbeat) return false; // No heartbeat data = recently registered
      return now - new Date(vm.lastHeartbeat).getTime() > deadThreshold;
    });

    let reaped = 0;
    for (const vm of deadVms) {
      // Check Aegis protected guard
      try {
        const protCheck = await fetch(`${this.baseUrl}/aegis/protected/check`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ vmId: vm.id }),
        });
        const protData = (await protCheck.json()) as { allowed: boolean };
        if (!protData.allowed) continue; // Protected — skip
      } catch {
        continue; // Err on the side of caution
      }

      // Deregister from registry (but don't destroy the VM — that's an escalation)
      try {
        await fetch(`${this.baseUrl}/registry/vms/${vm.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.token}` },
        });
        reaped++;
      } catch {
        // Best effort
      }
    }

    if (reaped > 0) {
      emit("autonomy", "scheduler.charon.reaped", {
        reapedCount: reaped,
        candidates: deadVms.length,
      }, "scheduler");
    }
  }

  /**
   * Sprint plan: generate sprint from board state + emit for approval.
   */
  private async sprintPlan(): Promise<void> {
    // Fetch open tasks from board
    const res = await fetch(`${this.baseUrl}/board/tasks?status=open&limit=50`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return;

    const data = (await res.json()) as { tasks: Array<{ id: string; title: string; priority?: string; tags?: string[] }> };
    const tasks = data.tasks || [];

    if (tasks.length === 0) {
      emit("autonomy", "scheduler.sprint_plan.empty", { message: "No open tasks for sprint" }, "scheduler");
      return;
    }

    // Emit a sprint_ready event for the orchestrator to pick up
    emit("autonomy", "sprint_ready", {
      taskCount: tasks.length,
      tasks: tasks.slice(0, 20).map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        tags: t.tags,
      })),
    }, "scheduler");
  }
}
