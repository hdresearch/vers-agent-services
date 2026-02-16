/**
 * Autonomy Store — SQLite-backed state for the autonomous loop.
 * Tracks: enabled state, pending escalations, action history, schedule config.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Escalation {
  id: string;
  type: "budget_warning" | "agent_failure" | "security_event" | "sprint_approval" | "fleet_message" | "blocker";
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected" | "expired";
  metadata?: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface AutonomyAction {
  id: string;
  actionType: string;
  trigger: string;
  description: string;
  result: "pending" | "success" | "failure" | "blocked";
  resultDetail?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  task: string;
  intervalMs: number;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

// ── Never auto-approve list ──────────────────────────────────────────────────

export const NEVER_AUTO_APPROVE = [
  "infra_deletion",
  "key_rotation",
  "external_fleet_communication",
  "budget_increase",
] as const;

export type NeverAutoApproveAction = typeof NEVER_AUTO_APPROVE[number];

// ── Store ────────────────────────────────────────────────────────────────────

export class AutonomyStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath = "data/autonomy.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS escalations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

      CREATE TABLE IF NOT EXISTS autonomy_actions (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        trigger TEXT NOT NULL,
        description TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT 'pending',
        result_detail TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_actions_ts ON autonomy_actions(created_at);

      CREATE TABLE IF NOT EXISTS schedule (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        task TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT
      );
    `);

    // Seed default state
    this.seedState();
    this.seedSchedule();
  }

  private seedState(): void {
    const count = this.db.prepare(`SELECT COUNT(*) as c FROM autonomy_state`).get() as { c: number };
    if (count.c === 0) {
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO autonomy_state (key, value) VALUES (?, ?)`);
      stmt.run("enabled", "false");
      stmt.run("started_at", "");
      stmt.run("last_tick_at", "");
    }
  }

  private seedSchedule(): void {
    const count = this.db.prepare(`SELECT COUNT(*) as c FROM schedule`).get() as { c: number };
    if (count.c === 0) {
      const defaults: Array<{ name: string; task: string; intervalMs: number }> = [
        { name: "health_check", task: "health_check", intervalMs: 30 * 60 * 1000 },
        { name: "scribe_kb", task: "scribe_kb", intervalMs: 60 * 60 * 1000 },
        { name: "charon_reap", task: "charon_reap", intervalMs: 4 * 60 * 60 * 1000 },
        { name: "sprint_plan", task: "sprint_plan", intervalMs: 6 * 60 * 60 * 1000 },
      ];
      const stmt = this.db.prepare(
        `INSERT INTO schedule (id, name, task, interval_ms, enabled) VALUES (?, ?, ?, ?, 1)`
      );
      for (const d of defaults) {
        stmt.run(ulid(), d.name, d.task, d.intervalMs);
      }
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────

  getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM autonomy_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO autonomy_state (key, value) VALUES (?, ?)`).run(key, value);
  }

  isEnabled(): boolean {
    return this.getState("enabled") === "true";
  }

  // ── Escalations ────────────────────────────────────────────────────────────

  createEscalation(input: Pick<Escalation, "type" | "title" | "detail" | "metadata">): Escalation {
    const esc: Escalation = {
      id: ulid(),
      type: input.type,
      title: input.title,
      detail: input.detail,
      status: "pending",
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO escalations (id, type, title, detail, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(esc.id, esc.type, esc.title, esc.detail, esc.status, JSON.stringify(esc.metadata || {}), esc.createdAt);
    return esc;
  }

  getEscalation(id: string): Escalation | null {
    const row = this.db.prepare(
      `SELECT id, type, title, detail, status, metadata, created_at as createdAt, resolved_at as resolvedAt, resolved_by as resolvedBy FROM escalations WHERE id = ?`
    ).get(id) as any;
    if (!row) return null;
    return { ...row, metadata: JSON.parse(row.metadata || "{}") };
  }

  getPendingEscalations(): Escalation[] {
    const rows = this.db.prepare(
      `SELECT id, type, title, detail, status, metadata, created_at as createdAt, resolved_at as resolvedAt, resolved_by as resolvedBy FROM escalations WHERE status = 'pending' ORDER BY created_at DESC`
    ).all() as any[];
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata || "{}") }));
  }

  resolveEscalation(id: string, action: "approved" | "rejected", resolvedBy = "human"): Escalation | null {
    const esc = this.getEscalation(id);
    if (!esc || esc.status !== "pending") return null;
    this.db.prepare(
      `UPDATE escalations SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`
    ).run(action, new Date().toISOString(), resolvedBy, id);
    return this.getEscalation(id);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  recordAction(input: Omit<AutonomyAction, "id" | "createdAt">): AutonomyAction {
    const action: AutonomyAction = {
      id: ulid(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO autonomy_actions (id, action_type, trigger, description, result, result_detail, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(action.id, action.actionType, action.trigger, action.description, action.result, action.resultDetail || null, JSON.stringify(action.metadata || {}), action.createdAt);
    return action;
  }

  updateActionResult(id: string, result: AutonomyAction["result"], detail?: string): void {
    this.db.prepare(
      `UPDATE autonomy_actions SET result = ?, result_detail = ? WHERE id = ?`
    ).run(result, detail || null, id);
  }

  getActions(limit = 50): AutonomyAction[] {
    const rows = this.db.prepare(
      `SELECT id, action_type as actionType, trigger, description, result, result_detail as resultDetail, metadata, created_at as createdAt FROM autonomy_actions ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata || "{}") }));
  }

  // ── Schedule ───────────────────────────────────────────────────────────────

  getSchedule(): ScheduleEntry[] {
    return this.db.prepare(
      `SELECT id, name, task, interval_ms as intervalMs, enabled, last_run_at as lastRunAt, next_run_at as nextRunAt FROM schedule ORDER BY name`
    ).all() as ScheduleEntry[];
  }

  getScheduleEntry(name: string): ScheduleEntry | null {
    const row = this.db.prepare(
      `SELECT id, name, task, interval_ms as intervalMs, enabled, last_run_at as lastRunAt, next_run_at as nextRunAt FROM schedule WHERE name = ?`
    ).get(name) as ScheduleEntry | undefined;
    return row ?? null;
  }

  updateScheduleEntry(name: string, patch: Partial<Pick<ScheduleEntry, "intervalMs" | "enabled">>): ScheduleEntry | null {
    const entry = this.getScheduleEntry(name);
    if (!entry) return null;
    if (patch.intervalMs !== undefined) {
      this.db.prepare(`UPDATE schedule SET interval_ms = ? WHERE name = ?`).run(patch.intervalMs, name);
    }
    if (patch.enabled !== undefined) {
      this.db.prepare(`UPDATE schedule SET enabled = ? WHERE name = ?`).run(patch.enabled ? 1 : 0, name);
    }
    return this.getScheduleEntry(name);
  }

  markScheduleRun(name: string): void {
    const now = new Date();
    const entry = this.getScheduleEntry(name);
    if (!entry) return;
    const nextRun = new Date(now.getTime() + entry.intervalMs).toISOString();
    this.db.prepare(
      `UPDATE schedule SET last_run_at = ?, next_run_at = ? WHERE name = ?`
    ).run(now.toISOString(), nextRun, name);
  }

  close(): void {
    this.db.close();
  }
}
