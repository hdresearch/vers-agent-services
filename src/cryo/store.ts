import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { ValidationError, NotFoundError, ConflictError } from "../errors.js";

// Re-export for backwards compat
export { ValidationError, NotFoundError, ConflictError };

export type AgentStatus = "awake" | "hibernating" | "retired";
export type TrustLevel = "untrusted" | "basic" | "trusted" | "elevated" | "core";

export interface CommitEntry {
  commitId: string;
  vmId?: string;
  reason: string;
  summary: string;
  timestamp: string;
}

export interface NotableEvent {
  event: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface CryoAgent {
  name: string;
  displayName: string;
  persona: string;
  status: AgentStatus;
  currentVmId: string | null;
  latestCommitId: string | null;
  commitHistory: CommitEntry[];
  briefing: string | null;
  sessionsCompleted: number;
  tasksCompleted: number;
  reportsPublished: number;
  notableEvents: NotableEvent[];
  tags: string[];
  trustLevel: TrustLevel;
  totalTokensUsed: number;
  specializations: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  displayName?: string;
  persona: string;
  status?: AgentStatus;
  currentVmId?: string;
  latestCommitId?: string;
  briefing?: string;
  tags?: string[];
  trustLevel?: TrustLevel;
  specializations?: string[];
}

export interface UpdateAgentInput {
  displayName?: string;
  persona?: string;
  status?: AgentStatus;
  currentVmId?: string | null;
  latestCommitId?: string | null;
  briefing?: string | null;
  tags?: string[];
  trustLevel?: TrustLevel;
  specializations?: string[];
  sessionsCompleted?: number;
  tasksCompleted?: number;
  reportsPublished?: number;
  totalTokensUsed?: number;
}

export interface HibernateInput {
  commitId: string;
  vmId?: string;
  reason?: string;
  summary?: string;
}

export interface WakeInput {
  vmId: string;
  briefing?: string;
}

export interface AddEventInput {
  event: string;
  metadata?: Record<string, unknown>;
}

export interface AgentFilters {
  status?: AgentStatus;
  persona?: string;
  tag?: string;
  trustLevel?: TrustLevel;
}

const VALID_STATUSES: Set<string> = new Set(["awake", "hibernating", "retired"]);
const VALID_TRUST_LEVELS: Set<string> = new Set(["untrusted", "basic", "trusted", "elevated", "core"]);
const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export class CryoStore {
  private agents: Map<string, CryoAgent> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/cryo-agents.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.agents)) {
          for (const a of data.agents) {
            this.agents.set(a.name, a);
          }
        }
      }
    } catch {
      this.agents = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const data = JSON.stringify({ agents: Array.from(this.agents.values()) }, null, 2);
    atomicWriteFileSync(this.filePath, data);
  }

  // --- CRUD ---

  createAgent(input: CreateAgentInput): CryoAgent {
    if (!input.name || typeof input.name !== "string") {
      throw new ValidationError("name is required");
    }
    if (!NAME_RE.test(input.name)) {
      throw new ValidationError("name must be lowercase alphanumeric, dashes, underscores, 1-63 chars, starting with a letter");
    }
    if (!input.persona || typeof input.persona !== "string") {
      throw new ValidationError("persona is required");
    }
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }
    if (input.trustLevel && !VALID_TRUST_LEVELS.has(input.trustLevel)) {
      throw new ValidationError(`invalid trustLevel: ${input.trustLevel}`);
    }
    if (this.agents.has(input.name)) {
      throw new ConflictError(`agent "${input.name}" already exists`);
    }

    const now = new Date().toISOString();
    const agent: CryoAgent = {
      name: input.name,
      displayName: input.displayName || input.name,
      persona: input.persona,
      status: input.status || "hibernating",
      currentVmId: input.currentVmId || null,
      latestCommitId: input.latestCommitId || null,
      commitHistory: [],
      briefing: input.briefing || null,
      sessionsCompleted: 0,
      tasksCompleted: 0,
      reportsPublished: 0,
      notableEvents: [],
      tags: input.tags || [],
      trustLevel: input.trustLevel || "basic",
      totalTokensUsed: 0,
      specializations: input.specializations || [],
      createdAt: now,
      updatedAt: now,
    };

    this.agents.set(agent.name, agent);
    this.scheduleSave();
    return agent;
  }

  getAgent(name: string): CryoAgent {
    const agent = this.agents.get(name);
    if (!agent) throw new NotFoundError(`agent "${name}" not found`);
    return agent;
  }

  listAgents(filters?: AgentFilters): CryoAgent[] {
    let result = Array.from(this.agents.values());
    if (filters?.status) result = result.filter(a => a.status === filters.status);
    if (filters?.persona) result = result.filter(a => a.persona === filters.persona);
    if (filters?.tag) result = result.filter(a => a.tags.includes(filters.tag!));
    if (filters?.trustLevel) result = result.filter(a => a.trustLevel === filters.trustLevel);
    return result;
  }

  updateAgent(name: string, input: UpdateAgentInput): CryoAgent {
    const agent = this.getAgent(name);
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }
    if (input.trustLevel && !VALID_TRUST_LEVELS.has(input.trustLevel)) {
      throw new ValidationError(`invalid trustLevel: ${input.trustLevel}`);
    }

    const fields: (keyof UpdateAgentInput)[] = [
      "displayName", "persona", "status", "currentVmId", "latestCommitId",
      "briefing", "tags", "trustLevel", "specializations",
      "sessionsCompleted", "tasksCompleted", "reportsPublished", "totalTokensUsed",
    ];
    for (const field of fields) {
      if (input[field] !== undefined) {
        (agent as any)[field] = input[field];
      }
    }
    agent.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return agent;
  }

  // --- Lifecycle ---

  hibernate(name: string, input: HibernateInput): CryoAgent {
    const agent = this.getAgent(name);
    if (agent.status === "retired") {
      throw new ValidationError("cannot hibernate a retired agent");
    }
    if (!input.commitId) {
      throw new ValidationError("commitId is required for hibernation");
    }

    const entry: CommitEntry = {
      commitId: input.commitId,
      vmId: input.vmId,
      reason: input.reason || "hibernation",
      summary: input.summary || "Agent hibernated",
      timestamp: new Date().toISOString(),
    };

    agent.commitHistory.push(entry);
    agent.latestCommitId = input.commitId;
    agent.status = "hibernating";
    agent.currentVmId = null;
    agent.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return agent;
  }

  wake(name: string, input: WakeInput): CryoAgent {
    const agent = this.getAgent(name);
    if (agent.status === "retired") {
      throw new ValidationError("cannot wake a retired agent");
    }
    if (!input.vmId) {
      throw new ValidationError("vmId is required for waking");
    }

    agent.status = "awake";
    agent.currentVmId = input.vmId;
    if (input.briefing) agent.briefing = input.briefing;
    agent.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return agent;
  }

  retire(name: string): CryoAgent {
    const agent = this.getAgent(name);
    agent.status = "retired";
    agent.currentVmId = null;
    agent.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return agent;
  }

  // --- Events & History ---

  addEvent(name: string, input: AddEventInput): CryoAgent {
    const agent = this.getAgent(name);
    if (!input.event || typeof input.event !== "string") {
      throw new ValidationError("event is required");
    }
    agent.notableEvents.push({
      event: input.event,
      timestamp: new Date().toISOString(),
      metadata: input.metadata,
    });
    agent.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return agent;
  }

  getHistory(name: string): CommitEntry[] {
    return this.getAgent(name).commitHistory;
  }

  composeBriefing(name: string): string {
    const agent = this.getAgent(name);
    const lines: string[] = [];

    lines.push(`# Welcome back, ${agent.displayName}`);
    lines.push("");
    lines.push(`## Persona: ${agent.persona}`);
    lines.push(`Trust level: ${agent.trustLevel}`);
    if (agent.specializations.length) {
      lines.push(`Specializations: ${agent.specializations.join(", ")}`);
    }
    lines.push("");

    lines.push("## Personal History");
    lines.push(`Sessions completed: ${agent.sessionsCompleted}`);
    lines.push(`Tasks completed: ${agent.tasksCompleted}`);
    lines.push(`Reports published: ${agent.reportsPublished}`);
    lines.push(`Total tokens used: ${agent.totalTokensUsed.toLocaleString()}`);
    lines.push("");

    if (agent.latestCommitId) {
      lines.push(`## Last Snapshot`);
      lines.push(`Commit: ${agent.latestCommitId}`);
      const last = agent.commitHistory[agent.commitHistory.length - 1];
      if (last) {
        lines.push(`Reason: ${last.reason}`);
        lines.push(`Summary: ${last.summary}`);
        lines.push(`When: ${last.timestamp}`);
      }
      lines.push("");
    }

    if (agent.notableEvents.length) {
      lines.push("## Recent Events");
      const recent = agent.notableEvents.slice(-10);
      for (const e of recent) {
        lines.push(`- [${e.timestamp}] ${e.event}`);
      }
      lines.push("");
    }

    if (agent.briefing) {
      lines.push("## Standing Briefing");
      lines.push(agent.briefing);
      lines.push("");
    }

    lines.push("---");
    lines.push(`*Cryochamber thaw complete. Status: ${agent.status}. You are ${agent.displayName}.*`);

    return lines.join("\n");
  }
}
