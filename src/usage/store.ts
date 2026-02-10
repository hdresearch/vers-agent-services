import { ulid } from "ulid";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

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
  range?: string; // e.g. "7d", "30d", "24h"
}

export interface VMFilters {
  role?: VMRole;
  agent?: string;
  range?: string;
}

export interface UsageSummary {
  range: string;
  totals: {
    tokens: number;
    cost: number;
    sessions: number;
    vms: number;
  };
  byAgent: Record<string, { tokens: number; cost: number; sessions: number }>;
}

// --- Validation ---

const VALID_VM_ROLES: Set<string> = new Set([
  "orchestrator",
  "lieutenant",
  "worker",
  "infra",
  "golden",
]);

function parseDuration(duration: string): number | null {
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

// --- Store ---

export class UsageStore {
  private sessions: SessionRecord[] = [];
  private vms: VMRecord[] = [];
  private sessionsPath: string;
  private vmsPath: string;

  constructor(
    sessionsPath = "data/usage-sessions.jsonl",
    vmsPath = "data/usage-vms.jsonl"
  ) {
    this.sessionsPath = sessionsPath;
    this.vmsPath = vmsPath;
    this.loadSessions();
    this.loadVMs();
  }

  private loadSessions(): void {
    if (!existsSync(this.sessionsPath)) return;
    const content = readFileSync(this.sessionsPath, "utf-8").trim();
    if (!content) return;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.sessions.push(JSON.parse(line) as SessionRecord);
      } catch {
        // skip malformed lines
      }
    }
  }

  private loadVMs(): void {
    if (!existsSync(this.vmsPath)) return;
    const content = readFileSync(this.vmsPath, "utf-8").trim();
    if (!content) return;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.vms.push(JSON.parse(line) as VMRecord);
      } catch {
        // skip malformed lines
      }
    }
  }

  private appendToFile(filePath: string, record: object): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + "\n");
  }

  // --- Sessions ---

  recordSession(input: SessionInput): SessionRecord {
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

    const record: SessionRecord = {
      id: ulid(),
      sessionId: input.sessionId.trim(),
      agent: input.agent.trim(),
      parentAgent: input.parentAgent?.trim() || null,
      model: input.model.trim(),
      tokens: input.tokens,
      cost: input.cost,
      turns: input.turns,
      toolCalls: input.toolCalls || {},
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      recordedAt: new Date().toISOString(),
    };

    this.sessions.push(record);
    this.appendToFile(this.sessionsPath, record);
    return record;
  }

  listSessions(filters?: SessionFilters): SessionRecord[] {
    let results = [...this.sessions];

    if (filters?.agent) {
      results = results.filter((s) => s.agent === filters.agent);
    }
    if (filters?.range) {
      const ms = parseDuration(filters.range);
      if (ms !== null) {
        const cutoff = Date.now() - ms;
        results = results.filter(
          (s) => new Date(s.startedAt).getTime() >= cutoff
        );
      }
    }

    // Sort by startedAt descending (most recent first)
    results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return results;
  }

  // --- VMs ---

  recordVM(input: VMInput): VMRecord {
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

    // Check if this is an update (destroy event for existing VM)
    const existing = this.vms.find((v) => v.vmId === input.vmId.trim());
    if (existing && input.destroyedAt) {
      existing.destroyedAt = input.destroyedAt;
      // Rewrite not needed for JSONL — we append the updated record
      // Consumers should use the latest record for each vmId
      const updated: VMRecord = { ...existing };
      this.appendToFile(this.vmsPath, updated);
      return updated;
    }

    const record: VMRecord = {
      id: ulid(),
      vmId: input.vmId.trim(),
      role: input.role,
      agent: input.agent.trim(),
      commitId: input.commitId?.trim(),
      createdAt: input.createdAt,
      destroyedAt: input.destroyedAt,
      recordedAt: new Date().toISOString(),
    };

    this.vms.push(record);
    this.appendToFile(this.vmsPath, record);
    return record;
  }

  listVMs(filters?: VMFilters): VMRecord[] {
    // Deduplicate by vmId — take latest record per vmId
    const byVmId = new Map<string, VMRecord>();
    for (const vm of this.vms) {
      byVmId.set(vm.vmId, vm);
    }
    let results = Array.from(byVmId.values());

    if (filters?.role) {
      results = results.filter((v) => v.role === filters.role);
    }
    if (filters?.agent) {
      results = results.filter((v) => v.agent === filters.agent);
    }
    if (filters?.range) {
      const ms = parseDuration(filters.range);
      if (ms !== null) {
        const cutoff = Date.now() - ms;
        results = results.filter(
          (v) => new Date(v.createdAt).getTime() >= cutoff
        );
      }
    }

    // Sort by createdAt descending
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  // --- Summary ---

  summary(range = "7d"): UsageSummary {
    const sessions = this.listSessions({ range });
    const vms = this.listVMs({ range });

    const byAgent: Record<string, { tokens: number; cost: number; sessions: number }> = {};

    let totalTokens = 0;
    let totalCost = 0;

    for (const session of sessions) {
      totalTokens += session.tokens.total;
      totalCost += session.cost.total;

      if (!byAgent[session.agent]) {
        byAgent[session.agent] = { tokens: 0, cost: 0, sessions: 0 };
      }
      byAgent[session.agent].tokens += session.tokens.total;
      byAgent[session.agent].cost += session.cost.total;
      byAgent[session.agent].sessions += 1;
    }

    // Round cost to 2 decimal places
    totalCost = Math.round(totalCost * 100) / 100;
    for (const agent of Object.keys(byAgent)) {
      byAgent[agent].cost = Math.round(byAgent[agent].cost * 100) / 100;
    }

    return {
      range,
      totals: {
        tokens: totalTokens,
        cost: totalCost,
        sessions: sessions.length,
        vms: vms.length,
      },
      byAgent,
    };
  }

  // --- Accessors for testing ---

  get sessionCount(): number {
    return this.sessions.length;
  }

  get vmCount(): number {
    return this.vms.length;
  }
}
