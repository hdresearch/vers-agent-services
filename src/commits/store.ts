import { ulid } from "ulid";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface CommitEntry {
  id: string;
  commitId: string;
  vmId: string;
  timestamp: string;
  label?: string;
  agent?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface RecordCommitInput {
  commitId: string;
  vmId: string;
  label?: string;
  agent?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CommitFilters {
  tag?: string;
  agent?: string;
  label?: string;
  since?: string; // ISO timestamp
  vmId?: string;
}

export class CommitStore {
  private entries: CommitEntry[] = [];
  private byCommitId: Map<string, CommitEntry> = new Map();
  private filePath: string;

  constructor(filePath = "data/commits.jsonl") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return;
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as CommitEntry;
        this.entries.push(entry);
        this.byCommitId.set(entry.commitId, entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  private persist(entry: CommitEntry): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  private rewrite(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const content = this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
    writeFileSync(this.filePath, content, "utf-8");
  }

  record(input: RecordCommitInput): CommitEntry {
    if (!input.commitId || typeof input.commitId !== "string" || !input.commitId.trim()) {
      throw new ValidationError("commitId is required");
    }
    if (!input.vmId || typeof input.vmId !== "string" || !input.vmId.trim()) {
      throw new ValidationError("vmId is required");
    }
    if (this.byCommitId.has(input.commitId.trim())) {
      throw new ConflictError("commit already recorded");
    }
    if (input.tags !== undefined && !Array.isArray(input.tags)) {
      throw new ValidationError("tags must be an array");
    }

    const entry: CommitEntry = {
      id: ulid(),
      commitId: input.commitId.trim(),
      vmId: input.vmId.trim(),
      timestamp: new Date().toISOString(),
    };
    if (input.label?.trim()) entry.label = input.label.trim();
    if (input.agent?.trim()) entry.agent = input.agent.trim();
    if (input.tags && input.tags.length > 0) entry.tags = input.tags.map((t) => t.trim());
    if (input.metadata !== undefined) entry.metadata = input.metadata;

    this.entries.push(entry);
    this.byCommitId.set(entry.commitId, entry);
    this.persist(entry);
    return entry;
  }

  get(commitId: string): CommitEntry | undefined {
    return this.byCommitId.get(commitId);
  }

  list(filters?: CommitFilters): CommitEntry[] {
    let result = this.entries;

    if (filters?.tag) {
      const tag = filters.tag;
      result = result.filter((e) => e.tags?.includes(tag));
    }
    if (filters?.agent) {
      result = result.filter((e) => e.agent === filters.agent);
    }
    if (filters?.label) {
      result = result.filter((e) => e.label === filters.label);
    }
    if (filters?.vmId) {
      result = result.filter((e) => e.vmId === filters.vmId);
    }
    if (filters?.since) {
      const sinceTime = new Date(filters.since).getTime();
      result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceTime);
    }

    // Return newest first
    return [...result].reverse();
  }

  remove(commitId: string): boolean {
    const entry = this.byCommitId.get(commitId);
    if (!entry) return false;

    this.byCommitId.delete(commitId);
    this.entries = this.entries.filter((e) => e.commitId !== commitId);
    this.rewrite();
    return true;
  }

  clear(): void {
    this.entries = [];
    this.byCommitId.clear();
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, "");
  }

  get size(): number {
    return this.entries.length;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
