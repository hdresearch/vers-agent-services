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

  private async tickRole(role: RoleConfig): Promise<void> {
    const run: RunRecord = {
      id: ulid(),
      role: role.name,
      startedAt: new Date().toISOString(),
      result: "pending",
    };

    role.lastRun = run.startedAt;
    role.runCount++;

    try {
      if (this.onTick) {
        await this.onTick(role);
      }
      run.result = "success";
      run.completedAt = new Date().toISOString();
      role.lastResult = "success";
    } catch (err) {
      run.result = "error";
      run.detail = err instanceof Error ? err.message : String(err);
      run.completedAt = new Date().toISOString();
      role.lastResult = `error: ${run.detail}`;
    }

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

  get isRunning(): boolean {
    return this.running;
  }
}
