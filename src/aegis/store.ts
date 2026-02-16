import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  maxTokensPerHour: number;
  maxTokensPerDay: number;
  maxCostPerDay: number; // in USD cents
}

export interface BudgetRecord {
  id: string;
  agentId: string;
  tokens: number;
  costCents: number;
  timestamp: string;
}

export interface BudgetStatus {
  agentId: string;
  tokensThisHour: number;
  tokensToday: number;
  costTodayCents: number;
  blocked: boolean;
  reason?: string;
}

export interface SpawnConfig {
  maxConcurrentVMs: number;
  maxSpawnsPerHour: number;
  circuitBreakerThreshold: number; // consecutive failures to trigger breaker
}

export interface SpawnRecord {
  id: string;
  vmId: string;
  agentId: string;
  action: "spawn" | "destroy" | "failure";
  timestamp: string;
}

export interface SpawnStatus {
  activeVMs: number;
  spawnsThisHour: number;
  consecutiveFailures: number;
  circuitBreakerOpen: boolean;
  config: SpawnConfig;
}

export interface ProtectedResource {
  id: string;
  vmId: string;
  label: string;
  reason: string;
  addedAt: string;
  addedBy: string;
}

export interface AuditEntry {
  id: string;
  service: "budget" | "spawn" | "protected";
  action: string;
  detail: string;
  timestamp: string;
}

// ── Default configs ──────────────────────────────────────────────────────────

const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxTokensPerHour: 2_000_000,
  maxTokensPerDay: 20_000_000,
  maxCostPerDay: 5000, // $50 in cents
};

const DEFAULT_SPAWN_CONFIG: SpawnConfig = {
  maxConcurrentVMs: 15,
  maxSpawnsPerHour: 30,
  circuitBreakerThreshold: 5,
};

// ── Store ────────────────────────────────────────────────────────────────────

export class AegisStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath = "data/aegis.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_records (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        cost_cents INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_budget_agent_ts ON budget_records(agent_id, timestamp);

      CREATE TABLE IF NOT EXISTS spawn_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spawn_records (
        id TEXT PRIMARY KEY,
        vm_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_spawn_ts ON spawn_records(timestamp);

      CREATE TABLE IF NOT EXISTS protected_resources (
        id TEXT PRIMARY KEY,
        vm_id TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        added_at TEXT NOT NULL,
        added_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
    `);

    // Seed default configs if empty
    this.seedConfig("budget_config", DEFAULT_BUDGET_CONFIG as unknown as Record<string, string | number | boolean>);
    this.seedConfig("spawn_config", DEFAULT_SPAWN_CONFIG as unknown as Record<string, string | number | boolean>);
  }

  private seedConfig(table: string, defaults: Record<string, string | number | boolean>): void {
    const count = this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
    if (count.c === 0) {
      const stmt = this.db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`);
      for (const [k, v] of Object.entries(defaults)) {
        stmt.run(k, String(v));
      }
    }
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  audit(service: AuditEntry["service"], action: string, detail: string): void {
    this.db.prepare(
      `INSERT INTO audit_log (id, service, action, detail, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).run(ulid(), service, action, detail, new Date().toISOString());
  }

  getAuditLog(limit = 100): AuditEntry[] {
    return this.db.prepare(
      `SELECT id, service, action, detail, timestamp FROM audit_log ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as AuditEntry[];
  }

  // ── Budget Config ──────────────────────────────────────────────────────────

  getBudgetConfig(): BudgetConfig {
    const rows = this.db.prepare(`SELECT key, value FROM budget_config`).all() as Array<{ key: string; value: string }>;
    const cfg: Record<string, number> = {};
    for (const r of rows) cfg[r.key] = Number(r.value);
    return {
      maxTokensPerHour: cfg.maxTokensPerHour ?? DEFAULT_BUDGET_CONFIG.maxTokensPerHour,
      maxTokensPerDay: cfg.maxTokensPerDay ?? DEFAULT_BUDGET_CONFIG.maxTokensPerDay,
      maxCostPerDay: cfg.maxCostPerDay ?? DEFAULT_BUDGET_CONFIG.maxCostPerDay,
    };
  }

  setBudgetConfig(config: Partial<BudgetConfig>): BudgetConfig {
    const current = this.getBudgetConfig();
    const merged = { ...current, ...config };
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO budget_config (key, value) VALUES (?, ?)`);
    for (const [k, v] of Object.entries(merged)) {
      stmt.run(k, String(v));
    }
    this.audit("budget", "config_updated", JSON.stringify(merged));
    return merged;
  }

  // ── Budget Records ─────────────────────────────────────────────────────────

  recordTokenUsage(agentId: string, tokens: number, costCents: number): BudgetRecord {
    const record: BudgetRecord = {
      id: ulid(),
      agentId,
      tokens,
      costCents,
      timestamp: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO budget_records (id, agent_id, tokens, cost_cents, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).run(record.id, record.agentId, record.tokens, record.costCents, record.timestamp);
    return record;
  }

  getTokensInWindow(agentId: string | null, windowMs: number): number {
    const since = new Date(Date.now() - windowMs).toISOString();
    if (agentId) {
      const row = this.db.prepare(
        `SELECT COALESCE(SUM(tokens), 0) as total FROM budget_records WHERE agent_id = ? AND timestamp >= ?`
      ).get(agentId, since) as { total: number };
      return row.total;
    }
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(tokens), 0) as total FROM budget_records WHERE timestamp >= ?`
    ).get(since) as { total: number };
    return row.total;
  }

  getCostInWindow(agentId: string | null, windowMs: number): number {
    const since = new Date(Date.now() - windowMs).toISOString();
    if (agentId) {
      const row = this.db.prepare(
        `SELECT COALESCE(SUM(cost_cents), 0) as total FROM budget_records WHERE agent_id = ? AND timestamp >= ?`
      ).get(agentId, since) as { total: number };
      return row.total;
    }
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(cost_cents), 0) as total FROM budget_records WHERE timestamp >= ?`
    ).get(since) as { total: number };
    return row.total;
  }

  getBudgetStatus(agentId?: string): BudgetStatus {
    const config = this.getBudgetConfig();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    const tokensThisHour = this.getTokensInWindow(agentId ?? null, HOUR);
    const tokensToday = this.getTokensInWindow(agentId ?? null, DAY);
    const costTodayCents = this.getCostInWindow(agentId ?? null, DAY);

    let blocked = false;
    let reason: string | undefined;

    if (tokensThisHour >= config.maxTokensPerHour) {
      blocked = true;
      reason = `Hourly token limit exceeded (${tokensThisHour}/${config.maxTokensPerHour})`;
    } else if (tokensToday >= config.maxTokensPerDay) {
      blocked = true;
      reason = `Daily token limit exceeded (${tokensToday}/${config.maxTokensPerDay})`;
    } else if (costTodayCents >= config.maxCostPerDay) {
      blocked = true;
      reason = `Daily cost limit exceeded ($${(costTodayCents / 100).toFixed(2)}/$${(config.maxCostPerDay / 100).toFixed(2)})`;
    }

    return {
      agentId: agentId ?? "__global__",
      tokensThisHour,
      tokensToday,
      costTodayCents,
      blocked,
      reason,
    };
  }

  // ── Spawn Config ───────────────────────────────────────────────────────────

  getSpawnConfig(): SpawnConfig {
    const rows = this.db.prepare(`SELECT key, value FROM spawn_config`).all() as Array<{ key: string; value: string }>;
    const cfg: Record<string, number> = {};
    for (const r of rows) cfg[r.key] = Number(r.value);
    return {
      maxConcurrentVMs: cfg.maxConcurrentVMs ?? DEFAULT_SPAWN_CONFIG.maxConcurrentVMs,
      maxSpawnsPerHour: cfg.maxSpawnsPerHour ?? DEFAULT_SPAWN_CONFIG.maxSpawnsPerHour,
      circuitBreakerThreshold: cfg.circuitBreakerThreshold ?? DEFAULT_SPAWN_CONFIG.circuitBreakerThreshold,
    };
  }

  setSpawnConfig(config: Partial<SpawnConfig>): SpawnConfig {
    const current = this.getSpawnConfig();
    const merged = { ...current, ...config };
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO spawn_config (key, value) VALUES (?, ?)`);
    for (const [k, v] of Object.entries(merged)) {
      stmt.run(k, String(v));
    }
    this.audit("spawn", "config_updated", JSON.stringify(merged));
    return merged;
  }

  // ── Spawn Records ──────────────────────────────────────────────────────────

  recordSpawn(vmId: string, agentId: string, action: SpawnRecord["action"]): SpawnRecord {
    const record: SpawnRecord = {
      id: ulid(),
      vmId,
      agentId,
      action,
      timestamp: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO spawn_records (id, vm_id, agent_id, action, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).run(record.id, record.vmId, record.agentId, record.action, record.timestamp);
    return record;
  }

  getActiveVMCount(): number {
    // Active = spawned but not destroyed
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT vm_id) as c FROM spawn_records
      WHERE action = 'spawn'
      AND vm_id NOT IN (SELECT vm_id FROM spawn_records WHERE action = 'destroy')
    `).get() as { c: number };
    return row.c;
  }

  getSpawnsInLastHour(): number {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(
      `SELECT COUNT(*) as c FROM spawn_records WHERE action = 'spawn' AND timestamp >= ?`
    ).get(since) as { c: number };
    return row.c;
  }

  getConsecutiveFailures(): number {
    // Count consecutive failures from latest record backwards
    const rows = this.db.prepare(
      `SELECT action FROM spawn_records ORDER BY timestamp DESC LIMIT 100`
    ).all() as Array<{ action: string }>;

    let count = 0;
    for (const r of rows) {
      if (r.action === "failure") count++;
      else break;
    }
    return count;
  }

  getSpawnStatus(): SpawnStatus {
    const config = this.getSpawnConfig();
    const activeVMs = this.getActiveVMCount();
    const spawnsThisHour = this.getSpawnsInLastHour();
    const consecutiveFailures = this.getConsecutiveFailures();
    const circuitBreakerOpen = consecutiveFailures >= config.circuitBreakerThreshold;

    return {
      activeVMs,
      spawnsThisHour,
      consecutiveFailures,
      circuitBreakerOpen,
      config,
    };
  }

  canSpawn(): { allowed: boolean; reason?: string } {
    const status = this.getSpawnStatus();
    if (status.circuitBreakerOpen) {
      return { allowed: false, reason: `Circuit breaker open: ${status.consecutiveFailures} consecutive failures` };
    }
    if (status.activeVMs >= status.config.maxConcurrentVMs) {
      return { allowed: false, reason: `Max concurrent VMs reached (${status.activeVMs}/${status.config.maxConcurrentVMs})` };
    }
    if (status.spawnsThisHour >= status.config.maxSpawnsPerHour) {
      return { allowed: false, reason: `Hourly spawn limit reached (${status.spawnsThisHour}/${status.config.maxSpawnsPerHour})` };
    }
    return { allowed: true };
  }

  resetCircuitBreaker(): void {
    // Record a synthetic "spawn" to break the consecutive failure chain
    this.audit("spawn", "circuit_breaker_reset", "Manual reset");
  }

  // ── Protected Resources ────────────────────────────────────────────────────

  addProtectedResource(vmId: string, label: string, reason: string, addedBy: string): ProtectedResource {
    const resource: ProtectedResource = {
      id: ulid(),
      vmId,
      label,
      reason,
      addedAt: new Date().toISOString(),
      addedBy,
    };
    this.db.prepare(
      `INSERT INTO protected_resources (id, vm_id, label, reason, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(resource.id, resource.vmId, resource.label, resource.reason, resource.addedAt, resource.addedBy);
    this.audit("protected", "resource_added", `${vmId} (${label}): ${reason}`);
    return resource;
  }

  removeProtectedResource(id: string): boolean {
    const resource = this.db.prepare(`SELECT id, vm_id, label FROM protected_resources WHERE id = ?`).get(id) as { id: string; vm_id: string; label: string } | undefined;
    if (!resource) return false;
    this.db.prepare(`DELETE FROM protected_resources WHERE id = ?`).run(id);
    this.audit("protected", "resource_removed", `${resource.vm_id} (${resource.label})`);
    return true;
  }

  getProtectedResources(): ProtectedResource[] {
    return this.db.prepare(
      `SELECT id, vm_id as vmId, label, reason, added_at as addedAt, added_by as addedBy FROM protected_resources ORDER BY added_at`
    ).all() as ProtectedResource[];
  }

  isProtected(vmId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM protected_resources WHERE vm_id = ?`).get(vmId);
    return !!row;
  }

  close(): void {
    this.db.close();
  }
}
