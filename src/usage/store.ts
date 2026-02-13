import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import duckdb from "duckdb";

// --- Types ---

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type VMRole = "orchestrator" | "lieutenant" | "worker" | "infra" | "golden";

export interface SessionRecord {
  id: string;
  sessionId: string;
  agent: string;
  parentAgent: string | null;
  model: string;
  tokens: TokenCounts;
  cost: CostBreakdown;
  turns: number;
  toolCalls: Record<string, number>;
  startedAt: string;
  endedAt: string;
  recordedAt: string;
}

export interface SessionInput {
  sessionId: string;
  agent: string;
  parentAgent?: string | null;
  model: string;
  tokens: TokenCounts;
  cost: CostBreakdown;
  turns: number;
  toolCalls?: Record<string, number>;
  startedAt: string;
  endedAt: string;
}

export interface VMRecord {
  id: string;
  vmId: string;
  role: VMRole;
  agent: string;
  commitId?: string;
  createdAt: string;
  destroyedAt?: string;
  recordedAt: string;
}

export interface VMInput {
  vmId: string;
  role: VMRole;
  agent: string;
  commitId?: string;
  createdAt: string;
  destroyedAt?: string;
}

export interface SessionFilters {
  agent?: string;
  range?: string;
}

export interface VMFilters {
  role?: VMRole;
  agent?: string;
  range?: string;
}

export interface AgentUsage {
  tokens: number;
  cost: number;
  sessions: number;
}

export interface UsageSummary {
  range: string;
  totals: {
    tokens: number;
    cost: number;
    sessions: number;
    vms: number;
  };
  byAgent: Record<string, AgentUsage>;
}

// --- Validation ---

const VALID_VM_ROLES: Set<string> = new Set([
  "orchestrator",
  "lieutenant",
  "worker",
  "infra",
  "golden",
]);

function parseDurationMs(duration: string): number | null {
  const match = duration.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return null;
}

function validateTokenCounts(tokens: any): tokens is TokenCounts {
  return (
    tokens &&
    typeof tokens === "object" &&
    typeof tokens.input === "number" &&
    typeof tokens.output === "number" &&
    typeof tokens.cacheRead === "number" &&
    typeof tokens.cacheWrite === "number" &&
    typeof tokens.total === "number"
  );
}

function validateCostBreakdown(cost: any): cost is CostBreakdown {
  return (
    cost &&
    typeof cost === "object" &&
    typeof cost.input === "number" &&
    typeof cost.output === "number" &&
    typeof cost.cacheRead === "number" &&
    typeof cost.cacheWrite === "number" &&
    typeof cost.total === "number"
  );
}

// --- Errors ---

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// --- Promisified DuckDB helpers ---

function dbRun(conn: duckdb.Connection, sql: string, ...params: any[]): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function dbAll(conn: duckdb.Connection, sql: string, ...params: any[]): Promise<duckdb.TableData> {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err: any, rows: duckdb.TableData) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// --- Store ---

export class UsageStore {
  private db: duckdb.Database;
  private conn: duckdb.Connection;
  private ready: Promise<void>;

  constructor(dbPath = "data/usage.duckdb") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new duckdb.Database(dbPath);
    this.conn = this.db.connect();
    this.ready = this.initTables();
  }

  private async initTables(): Promise<void> {
    await dbRun(
      this.conn,
      `CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR PRIMARY KEY,
        session_id VARCHAR NOT NULL,
        agent VARCHAR NOT NULL,
        parent_agent VARCHAR,
        model VARCHAR NOT NULL,
        tokens_input INTEGER NOT NULL,
        tokens_output INTEGER NOT NULL,
        tokens_cache_read INTEGER NOT NULL,
        tokens_cache_write INTEGER NOT NULL,
        tokens_total INTEGER NOT NULL,
        cost_input DOUBLE NOT NULL,
        cost_output DOUBLE NOT NULL,
        cost_cache_read DOUBLE NOT NULL,
        cost_cache_write DOUBLE NOT NULL,
        cost_total DOUBLE NOT NULL,
        turns INTEGER NOT NULL,
        tool_calls JSON NOT NULL,
        started_at TIMESTAMP NOT NULL,
        ended_at TIMESTAMP NOT NULL,
        recorded_at TIMESTAMP NOT NULL
      )`
    );

    await dbRun(
      this.conn,
      `CREATE TABLE IF NOT EXISTS vm_records (
        id VARCHAR PRIMARY KEY,
        vm_id VARCHAR NOT NULL,
        role VARCHAR NOT NULL,
        agent VARCHAR NOT NULL,
        commit_id VARCHAR,
        created_at TIMESTAMP NOT NULL,
        destroyed_at TIMESTAMP,
        recorded_at TIMESTAMP NOT NULL
      )`
    );
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  // --- Sessions ---

  async recordSession(input: SessionInput): Promise<SessionRecord> {
    await this.ready;

    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.trim()) {
      throw new ValidationError("sessionId is required");
    }
    if (!input.agent || typeof input.agent !== "string" || !input.agent.trim()) {
      throw new ValidationError("agent is required");
    }
    if (!input.model || typeof input.model !== "string" || !input.model.trim()) {
      throw new ValidationError("model is required");
    }
    if (!validateTokenCounts(input.tokens)) {
      throw new ValidationError("tokens must include input, output, cacheRead, cacheWrite, total as numbers");
    }
    if (!validateCostBreakdown(input.cost)) {
      throw new ValidationError("cost must include input, output, cacheRead, cacheWrite, total as numbers");
    }
    if (typeof input.turns !== "number" || input.turns < 0) {
      throw new ValidationError("turns must be a non-negative number");
    }
    if (!input.startedAt || typeof input.startedAt !== "string") {
      throw new ValidationError("startedAt is required");
    }
    if (!input.endedAt || typeof input.endedAt !== "string") {
      throw new ValidationError("endedAt is required");
    }

    const id = ulid();
    const now = new Date().toISOString();
    const toolCalls = input.toolCalls || {};

    await dbRun(
      this.conn,
      `INSERT INTO sessions VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      id,
      input.sessionId.trim(),
      input.agent.trim(),
      input.parentAgent?.trim() || null,
      input.model.trim(),
      input.tokens.input,
      input.tokens.output,
      input.tokens.cacheRead,
      input.tokens.cacheWrite,
      input.tokens.total,
      input.cost.input,
      input.cost.output,
      input.cost.cacheRead,
      input.cost.cacheWrite,
      input.cost.total,
      input.turns,
      JSON.stringify(toolCalls),
      input.startedAt,
      input.endedAt,
      now
    );

    return {
      id,
      sessionId: input.sessionId.trim(),
      agent: input.agent.trim(),
      parentAgent: input.parentAgent?.trim() || null,
      model: input.model.trim(),
      tokens: input.tokens,
      cost: input.cost,
      turns: input.turns,
      toolCalls,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      recordedAt: now,
    };
  }

  async listSessions(filters?: SessionFilters): Promise<SessionRecord[]> {
    await this.ready;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters?.agent) {
      conditions.push(`agent = $${paramIdx++}`);
      params.push(filters.agent);
    }
    if (filters?.range) {
      const ms = parseDurationMs(filters.range);
      if (ms !== null) {
        const cutoff = new Date(Date.now() - ms).toISOString();
        conditions.push(`started_at >= $${paramIdx++}`);
        params.push(cutoff);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM sessions ${where} ORDER BY started_at DESC`;
    const rows = await dbAll(this.conn, sql, ...params);

    return rows.map(rowToSession);
  }

  // --- VMs ---

  async recordVM(input: VMInput): Promise<VMRecord> {
    await this.ready;

    if (!input.vmId || typeof input.vmId !== "string" || !input.vmId.trim()) {
      throw new ValidationError("vmId is required");
    }
    if (!input.role || !VALID_VM_ROLES.has(input.role)) {
      throw new ValidationError(`invalid role: ${input.role}`);
    }
    if (!input.agent || typeof input.agent !== "string" || !input.agent.trim()) {
      throw new ValidationError("agent is required");
    }
    if (!input.createdAt || typeof input.createdAt !== "string") {
      throw new ValidationError("createdAt is required");
    }

    // Check if this is a destroy update for an existing VM
    if (input.destroyedAt) {
      const existing = await dbAll(
        this.conn,
        `SELECT * FROM vm_records WHERE vm_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        input.vmId.trim()
      );
      if (existing.length > 0) {
        await dbRun(
          this.conn,
          `UPDATE vm_records SET destroyed_at = $1 WHERE id = $2`,
          input.destroyedAt,
          existing[0].id
        );
        const updated = rowToVM(existing[0]);
        updated.destroyedAt = input.destroyedAt;
        return updated;
      }
    }

    const id = ulid();
    const now = new Date().toISOString();

    await dbRun(
      this.conn,
      `INSERT INTO vm_records VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      id,
      input.vmId.trim(),
      input.role,
      input.agent.trim(),
      input.commitId?.trim() || null,
      input.createdAt,
      input.destroyedAt || null,
      now
    );

    return {
      id,
      vmId: input.vmId.trim(),
      role: input.role,
      agent: input.agent.trim(),
      commitId: input.commitId?.trim(),
      createdAt: input.createdAt,
      destroyedAt: input.destroyedAt,
      recordedAt: now,
    };
  }

  async listVMs(filters?: VMFilters): Promise<VMRecord[]> {
    await this.ready;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters?.role) {
      conditions.push(`role = $${paramIdx++}`);
      params.push(filters.role);
    }
    if (filters?.agent) {
      conditions.push(`agent = $${paramIdx++}`);
      params.push(filters.agent);
    }
    if (filters?.range) {
      const ms = parseDurationMs(filters.range);
      if (ms !== null) {
        const cutoff = new Date(Date.now() - ms).toISOString();
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(cutoff);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM vm_records ${where} ORDER BY created_at DESC`;
    const rows = await dbAll(this.conn, sql, ...params);

    return rows.map(rowToVM);
  }

  // --- Summary (SQL aggregation) ---

  async summary(range = "7d"): Promise<UsageSummary> {
    await this.ready;

    const ms = parseDurationMs(range);
    const cutoff = ms !== null ? new Date(Date.now() - ms).toISOString() : new Date(0).toISOString();

    // Aggregate sessions by agent using SQL
    const agentRows = await dbAll(
      this.conn,
      `SELECT
        agent,
        SUM(tokens_total) as tokens,
        ROUND(SUM(cost_total), 2) as cost,
        COUNT(*) as sessions
      FROM sessions
      WHERE started_at >= $1
      GROUP BY agent
      ORDER BY cost DESC`,
      cutoff
    );

    // Total sessions
    const totalRows = await dbAll(
      this.conn,
      `SELECT
        COALESCE(SUM(tokens_total), 0) as tokens,
        ROUND(COALESCE(SUM(cost_total), 0), 2) as cost,
        COUNT(*) as sessions
      FROM sessions
      WHERE started_at >= $1`,
      cutoff
    );

    // Count VMs in range
    const vmRows = await dbAll(
      this.conn,
      `SELECT COUNT(*) as vms FROM vm_records WHERE created_at >= $1`,
      cutoff
    );

    const totals = totalRows[0] || { tokens: 0, cost: 0, sessions: 0 };
    const vmCount = vmRows[0]?.vms || 0;

    const byAgent: Record<string, AgentUsage> = {};
    for (const row of agentRows) {
      byAgent[row.agent] = {
        tokens: Number(row.tokens),
        cost: Number(row.cost),
        sessions: Number(row.sessions),
      };
    }

    return {
      range,
      totals: {
        tokens: Number(totals.tokens),
        cost: Number(totals.cost),
        sessions: Number(totals.sessions),
        vms: Number(vmCount),
      },
      byAgent,
    };
  }

  // --- Upsert (for periodic flush) ---

  async upsertSession(sessionId: string, input: SessionInput): Promise<SessionRecord> {
    await this.ready;

    if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
      throw new ValidationError("sessionId path parameter is required");
    }
    if (!input.agent || typeof input.agent !== "string" || !input.agent.trim()) {
      throw new ValidationError("agent is required");
    }
    if (!input.model || typeof input.model !== "string" || !input.model.trim()) {
      throw new ValidationError("model is required");
    }
    if (!validateTokenCounts(input.tokens)) {
      throw new ValidationError("tokens must include input, output, cacheRead, cacheWrite, total as numbers");
    }
    if (!validateCostBreakdown(input.cost)) {
      throw new ValidationError("cost must include input, output, cacheRead, cacheWrite, total as numbers");
    }
    if (typeof input.turns !== "number" || input.turns < 0) {
      throw new ValidationError("turns must be a non-negative number");
    }
    if (!input.startedAt || typeof input.startedAt !== "string") {
      throw new ValidationError("startedAt is required");
    }
    if (!input.endedAt || typeof input.endedAt !== "string") {
      throw new ValidationError("endedAt is required");
    }

    const trimmedId = sessionId.trim();
    const toolCalls = input.toolCalls || {};
    const now = new Date().toISOString();

    // Check if a row with this session_id already exists
    const existing = await dbAll(
      this.conn,
      `SELECT id FROM sessions WHERE session_id = $1 LIMIT 1`,
      trimmedId
    );

    if (existing.length > 0) {
      // Update in place
      await dbRun(
        this.conn,
        `UPDATE sessions SET
          agent = $1,
          parent_agent = $2,
          model = $3,
          tokens_input = $4,
          tokens_output = $5,
          tokens_cache_read = $6,
          tokens_cache_write = $7,
          tokens_total = $8,
          cost_input = $9,
          cost_output = $10,
          cost_cache_read = $11,
          cost_cache_write = $12,
          cost_total = $13,
          turns = $14,
          tool_calls = $15,
          ended_at = $16,
          recorded_at = $17
        WHERE session_id = $18`,
        input.agent.trim(),
        input.parentAgent?.trim() || null,
        input.model.trim(),
        input.tokens.input,
        input.tokens.output,
        input.tokens.cacheRead,
        input.tokens.cacheWrite,
        input.tokens.total,
        input.cost.input,
        input.cost.output,
        input.cost.cacheRead,
        input.cost.cacheWrite,
        input.cost.total,
        input.turns,
        JSON.stringify(toolCalls),
        input.endedAt,
        now,
        trimmedId
      );

      return {
        id: existing[0].id,
        sessionId: trimmedId,
        agent: input.agent.trim(),
        parentAgent: input.parentAgent?.trim() || null,
        model: input.model.trim(),
        tokens: input.tokens,
        cost: input.cost,
        turns: input.turns,
        toolCalls,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        recordedAt: now,
      };
    } else {
      // Insert new row
      const id = ulid();
      await dbRun(
        this.conn,
        `INSERT INTO sessions VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        id,
        trimmedId,
        input.agent.trim(),
        input.parentAgent?.trim() || null,
        input.model.trim(),
        input.tokens.input,
        input.tokens.output,
        input.tokens.cacheRead,
        input.tokens.cacheWrite,
        input.tokens.total,
        input.cost.input,
        input.cost.output,
        input.cost.cacheRead,
        input.cost.cacheWrite,
        input.cost.total,
        input.turns,
        JSON.stringify(toolCalls),
        input.startedAt,
        input.endedAt,
        now
      );

      return {
        id,
        sessionId: trimmedId,
        agent: input.agent.trim(),
        parentAgent: input.parentAgent?.trim() || null,
        model: input.model.trim(),
        tokens: input.tokens,
        cost: input.cost,
        turns: input.turns,
        toolCalls,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        recordedAt: now,
      };
    }
  }

  // --- Accessors for testing ---

  async sessionCount(): Promise<number> {
    await this.ready;
    const rows = await dbAll(this.conn, "SELECT COUNT(*) as cnt FROM sessions");
    return Number(rows[0].cnt);
  }

  async vmCount(): Promise<number> {
    await this.ready;
    const rows = await dbAll(this.conn, "SELECT COUNT(*) as cnt FROM vm_records");
    return Number(rows[0].cnt);
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// --- Row mappers ---

function rowToSession(row: duckdb.RowData): SessionRecord {
  let toolCalls: Record<string, number> = {};
  if (row.tool_calls) {
    toolCalls = typeof row.tool_calls === "string" ? JSON.parse(row.tool_calls) : row.tool_calls;
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    parentAgent: row.parent_agent || null,
    model: row.model,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
      total: row.tokens_total,
    },
    cost: {
      input: row.cost_input,
      output: row.cost_output,
      cacheRead: row.cost_cache_read,
      cacheWrite: row.cost_cache_write,
      total: row.cost_total,
    },
    turns: row.turns,
    toolCalls,
    startedAt: toISOString(row.started_at),
    endedAt: toISOString(row.ended_at),
    recordedAt: toISOString(row.recorded_at),
  };
}

function rowToVM(row: duckdb.RowData): VMRecord {
  const record: VMRecord = {
    id: row.id,
    vmId: row.vm_id,
    role: row.role as VMRole,
    agent: row.agent,
    createdAt: toISOString(row.created_at),
    recordedAt: toISOString(row.recorded_at),
  };
  if (row.commit_id) record.commitId = row.commit_id;
  if (row.destroyed_at) record.destroyedAt = toISOString(row.destroyed_at);
  return record;
}

/** DuckDB returns timestamps as Date objects — normalize to ISO string */
function toISOString(val: any): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val;
  return String(val);
}
