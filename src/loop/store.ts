import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { ValidationError, NotFoundError } from "../errors.js";

export interface RoleConfig {
  name: string;
  description: string;
  task: string; // What the role does each cycle
  intervalMs: number;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  runCount: number;
}

export interface LoopStatus {
  running: boolean;
  startedAt?: string;
  roles: RoleConfig[];
  uptime?: number; // seconds
}

export interface RunRecord {
  id: string;
  role: string;
  startedAt: string;
  completedAt?: string;
  result: "pending" | "success" | "error";
  detail?: string;
}

const DEFAULT_ROLES: RoleConfig[] = [
  {
    name: "Sentinel",
    description: "Health monitor — checks service health, registry liveness, and alerts on anomalies",
    task: "health",
    intervalMs: 15 * 60 * 1000, // 15 min
    enabled: true,
    runCount: 0,
  },
  {
    name: "Quartermaster",
    description: "Dispatch coordinator — monitors board for unassigned tasks, matches to available agents",
    task: "dispatch",
    intervalMs: 60 * 1000, // 1 min (continuous-ish)
    enabled: true,
    runCount: 0,
  },
  {
    name: "Scribe",
    description: "Documentation keeper — summarizes logs, updates changelogs, maintains institutional memory",
    task: "docs",
    intervalMs: 6 * 60 * 60 * 1000, // 6 hours
    enabled: true,
    runCount: 0,
  },
  {
    name: "Auditor",
    description: "Review analyst — checks completed tasks for quality, flags regressions, tracks metrics",
    task: "review",
    intervalMs: 4 * 60 * 60 * 1000, // 4 hours
    enabled: true,
    runCount: 0,
  },
];

export class LoopStore {
  private roles: RoleConfig[];
  private running = false;
  private startedAt?: string;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private activeTicks: Map<string, Promise<void>> = new Map();
  private shuttingDown = false;
  private runs: RunRecord[] = [];
  private filePath: string;
  private onTick?: (role: RoleConfig) => void | Promise<void>;

  constructor(filePath = "data/loop.json", onTick?: (role: RoleConfig) => void | Promise<void>) {
    this.filePath = filePath;
    this.onTick = onTick;
    this.roles = this.loadConfig();
  }

  private loadConfig(): RoleConfig[] {
    recoverTmpFile(this.filePath);
    if (!existsSync(this.filePath)) return JSON.parse(JSON.stringify(DEFAULT_ROLES));
    try {
      const content = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(content);
      if (data.roles && Array.isArray(data.roles)) {
        return data.roles;
      }
    } catch {
      // fall through
    }
    return JSON.parse(JSON.stringify(DEFAULT_ROLES));
  }

  private saveConfig(): void {
    atomicWriteFileSync(
      this.filePath,
      JSON.stringify({ roles: this.roles, running: this.running, startedAt: this.startedAt }, null, 2),
    );
  }

  getStatus(): LoopStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      roles: this.roles,
      uptime: this.startedAt
        ? Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000)
        : undefined,
    };
  }

  start(): LoopStatus {
    if (this.running) throw new ValidationError("Loop is already running");

    this.running = true;
    this.startedAt = new Date().toISOString();

    for (const role of this.roles) {
      if (role.enabled) {
        this.startRole(role);
      }
    }

    this.saveConfig();
    return this.getStatus();
  }

  /** Wait for all currently active (in-flight) ticks to complete */
  async waitForActiveTicks(): Promise<void> {
    const active = [...this.activeTicks.values()];
    if (active.length > 0) {
      await Promise.allSettled(active);
    }
  }

  stop(): LoopStatus {
    if (!this.running) throw new ValidationError("Loop is not running");

    for (const [name, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running = false;
    this.saveConfig();
    return this.getStatus();
  }

  private startRole(role: RoleConfig): void {
    // Run immediately, then on interval
    this.tickRole(role);
    const timer = setInterval(() => this.tickRole(role), role.intervalMs);
    this.timers.set(role.name, timer);
  }

  private tickRole(role: RoleConfig): void {
    // Don't start new ticks during shutdown
    if (this.shuttingDown) return;

    const run: RunRecord = {
      id: ulid(),
      role: role.name,
      startedAt: new Date().toISOString(),
      result: "pending",
    };

    role.lastRun = run.startedAt;
    role.runCount++;

    let tickResult: void | Promise<void> | undefined;
    try {
      if (this.onTick) {
        tickResult = this.onTick(role);
      }
    } catch (err) {
      // Sync error — record immediately
      run.result = "error";
      run.detail = err instanceof Error ? err.message : String(err);
      run.completedAt = new Date().toISOString();
      role.lastResult = `error: ${run.detail}`;
      this.recordRun(run);
      return;
    }

    // If onTick returned a promise, handle async completion
    if (tickResult && typeof (tickResult as any).then === "function") {
      const promise = (tickResult as Promise<void>)
        .then(() => {
          run.result = "success";
          run.completedAt = new Date().toISOString();
          role.lastResult = "success";
          this.recordRun(run);
        })
        .catch((err) => {
          run.result = "error";
          run.detail = err instanceof Error ? err.message : String(err);
          run.completedAt = new Date().toISOString();
          role.lastResult = `error: ${run.detail}`;
          this.recordRun(run);
        });
      this.activeTicks.set(role.name, promise);
      promise.finally(() => {
        if (this.activeTicks.get(role.name) === promise) {
          this.activeTicks.delete(role.name);
        }
      });
    } else {
      // Sync callback — record immediately
      run.result = "success";
      run.completedAt = new Date().toISOString();
      role.lastResult = "success";
      this.recordRun(run);
    }
  }

  private recordRun(run: RunRecord): void {
    this.runs.push(run);
    // Keep last 100 runs
    if (this.runs.length > 100) this.runs = this.runs.slice(-100);
    this.saveConfig();
  }

  getConfig(): RoleConfig[] {
    return this.roles;
  }

  patchConfig(name: string, patch: Partial<Pick<RoleConfig, "enabled" | "intervalMs" | "description" | "task">>): RoleConfig {
    const role = this.roles.find((r) => r.name === name);
    if (!role) throw new NotFoundError(`Role '${name}' not found`);

    if (patch.enabled !== undefined) role.enabled = patch.enabled;
    if (patch.intervalMs !== undefined) {
      if (patch.intervalMs < 10000) throw new ValidationError("intervalMs must be >= 10000 (10 seconds)");
      role.intervalMs = patch.intervalMs;
    }
    if (patch.description !== undefined) role.description = patch.description;
    if (patch.task !== undefined) role.task = patch.task;

    // Restart the role timer if loop is running
    if (this.running) {
      const existing = this.timers.get(role.name);
      if (existing) {
        clearInterval(existing);
        this.timers.delete(role.name);
      }
      if (role.enabled) {
        this.startRole(role);
      }
    }

    this.saveConfig();
    return role;
  }

  getRuns(roleName?: string, limit = 20): RunRecord[] {
    let result = this.runs;
    if (roleName) result = result.filter((r) => r.role === roleName);
    return result.slice(-limit);
  }

  /**
   * Graceful shutdown: clear all intervals, wait for in-flight ticks to complete.
   * Returns a promise that resolves when all active ticks have drained.
   */
  async shutdown(): Promise<LoopStatus> {
    this.shuttingDown = true;

    // Clear all interval timers so no new ticks fire
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();

    // Wait for any in-flight ticks to complete
    const active = [...this.activeTicks.entries()];
    if (active.length > 0) {
      console.log(`Loop shutdown: waiting for ${active.length} active tick(s) [${active.map(([name]) => name).join(", ")}]...`);
      await Promise.allSettled(active.map(([, p]) => p));
      console.log("Loop shutdown: all active ticks drained.");
    }

    this.running = false;
    this.shuttingDown = false;
    this.saveConfig();
    return this.getStatus();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get activeTickCount(): number {
    return this.activeTicks.size;
  }
}
