import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { ValidationError, NotFoundError } from "../errors.js";

// Re-export for backwards compat
export { ValidationError, NotFoundError };

export type KBEntryType = "lesson" | "convention" | "sop" | "gotcha" | "reference" | "decision";
export type KBPriority = "low" | "normal" | "high" | "critical";

export interface KBEntry {
  id: string;
  type: KBEntryType;
  title: string;
  content: string;
  source: string;         // e.g. "agent:backend-lt", "human:noah", "system"
  tags: string[];
  priority: KBPriority;
  decayDays: number | null;  // null = never expires
  expiresAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKBInput {
  type: KBEntryType;
  title: string;
  content: string;
  source?: string;
  tags?: string[];
  priority?: KBPriority;
  decayDays?: number | null;
}

export interface UpdateKBInput {
  type?: KBEntryType;
  title?: string;
  content?: string;
  source?: string;
  tags?: string[];
  priority?: KBPriority;
  decayDays?: number | null;
}

export interface KBFilters {
  type?: KBEntryType;
  tag?: string;
  priority?: KBPriority;
  source?: string;
  search?: string;
  includeExpired?: boolean;
}

const VALID_TYPES: Set<string> = new Set(["lesson", "convention", "sop", "gotcha", "reference", "decision"]);
const VALID_PRIORITIES: Set<string> = new Set(["low", "normal", "high", "critical"]);

export class KBStore {
  private entries: Map<string, KBEntry> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/kb.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.entries)) {
          for (const e of data.entries) {
            this.entries.set(e.id, e);
          }
        }
      }
    } catch {
      this.entries = new Map();
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
    const data = JSON.stringify({ entries: Array.from(this.entries.values()) }, null, 2);
    atomicWriteFileSync(this.filePath, data);
  }

  // --- CRUD ---

  create(input: CreateKBInput): KBEntry {
    if (!input.title?.trim()) throw new ValidationError("title is required");
    if (!input.content?.trim()) throw new ValidationError("content is required");
    if (!input.type || !VALID_TYPES.has(input.type)) {
      throw new ValidationError(`type must be one of: ${[...VALID_TYPES].join(", ")}`);
    }
    if (input.priority && !VALID_PRIORITIES.has(input.priority)) {
      throw new ValidationError(`priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
    }

    const now = new Date().toISOString();
    const decayDays = input.decayDays !== undefined ? input.decayDays : null;

    const entry: KBEntry = {
      id: ulid(),
      type: input.type,
      title: input.title.trim(),
      content: input.content.trim(),
      source: input.source?.trim() || "system",
      tags: input.tags || [],
      priority: input.priority || "normal",
      decayDays,
      expiresAt: decayDays != null
        ? new Date(Date.now() + decayDays * 86400000).toISOString()
        : null,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(entry.id, entry);
    this.scheduleSave();
    return entry;
  }

  get(id: string): KBEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundError(`KB entry "${id}" not found`);
    // Track access
    entry.accessCount++;
    entry.lastAccessedAt = new Date().toISOString();
    this.scheduleSave();
    return entry;
  }

  update(id: string, input: UpdateKBInput): KBEntry {
    const entry = this.get(id);
    if (input.type && !VALID_TYPES.has(input.type)) {
      throw new ValidationError(`type must be one of: ${[...VALID_TYPES].join(", ")}`);
    }
    if (input.priority && !VALID_PRIORITIES.has(input.priority)) {
      throw new ValidationError(`priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
    }

    if (input.title !== undefined) entry.title = input.title.trim();
    if (input.content !== undefined) entry.content = input.content.trim();
    if (input.type !== undefined) entry.type = input.type;
    if (input.source !== undefined) entry.source = input.source.trim();
    if (input.tags !== undefined) entry.tags = input.tags;
    if (input.priority !== undefined) entry.priority = input.priority;
    if (input.decayDays !== undefined) {
      entry.decayDays = input.decayDays;
      entry.expiresAt = input.decayDays != null
        ? new Date(Date.now() + input.decayDays * 86400000).toISOString()
        : null;
    }

    entry.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return entry;
  }

  delete(id: string): boolean {
    const existed = this.entries.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  // --- Query ---

  list(filters?: KBFilters): KBEntry[] {
    const now = new Date();
    let results = Array.from(this.entries.values());

    // Filter expired unless explicitly included
    if (!filters?.includeExpired) {
      results = results.filter(e =>
        !e.expiresAt || new Date(e.expiresAt) > now
      );
    }

    if (filters?.type) results = results.filter(e => e.type === filters.type);
    if (filters?.tag) results = results.filter(e => e.tags.includes(filters.tag!));
    if (filters?.priority) results = results.filter(e => e.priority === filters.priority);
    if (filters?.source) results = results.filter(e => e.source === filters.source);

    if (filters?.search) {
      const q = filters.search.toLowerCase();
      results = results.filter(e =>
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    // Sort: critical first, then high, normal, low; within same priority, newest first
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    results.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return b.createdAt.localeCompare(a.createdAt);
    });

    return results;
  }

  /**
   * Get a briefing document: all non-expired entries formatted as markdown,
   * suitable for injection into agent context.
   */
  briefing(opts?: { tags?: string[]; maxEntries?: number }): string {
    const now = new Date();
    let entries = Array.from(this.entries.values())
      .filter(e => !e.expiresAt || new Date(e.expiresAt) > now);

    if (opts?.tags?.length) {
      entries = entries.filter(e =>
        opts.tags!.some(t => e.tags.includes(t))
      );
    }

    // Sort by priority then recency
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    entries.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return b.createdAt.localeCompare(a.createdAt);
    });

    if (opts?.maxEntries) {
      entries = entries.slice(0, opts.maxEntries);
    }

    if (entries.length === 0) return "";

    const lines: string[] = [
      "# Fleet Knowledge Base",
      "",
      `_${entries.length} entries — auto-synced from infra_`,
      "",
    ];

    // Group by type
    const groups = new Map<string, KBEntry[]>();
    for (const e of entries) {
      if (!groups.has(e.type)) groups.set(e.type, []);
      groups.get(e.type)!.push(e);
    }

    const typeLabels: Record<string, string> = {
      critical: "🚨 Critical",
      gotcha: "⚠️ Gotchas",
      sop: "📋 SOPs",
      convention: "📐 Conventions",
      lesson: "💡 Lessons Learned",
      decision: "🔨 Decisions",
      reference: "📚 Reference",
    };

    // Emit critical-priority entries first regardless of type
    const criticals = entries.filter(e => e.priority === "critical");
    if (criticals.length > 0) {
      lines.push("## 🚨 Critical Knowledge");
      lines.push("");
      for (const e of criticals) {
        lines.push(`### ${e.title}`);
        lines.push(`_${e.type} | source: ${e.source} | tags: ${e.tags.join(", ") || "none"}_`);
        lines.push("");
        lines.push(e.content);
        lines.push("");
      }
    }

    // Then group the rest by type
    for (const [type, typeEntries] of groups) {
      const nonCritical = typeEntries.filter(e => e.priority !== "critical");
      if (nonCritical.length === 0) continue;

      lines.push(`## ${typeLabels[type] || type}`);
      lines.push("");
      for (const e of nonCritical) {
        lines.push(`### ${e.title}`);
        if (e.priority === "high") lines.push(`**Priority: HIGH**`);
        lines.push(`_source: ${e.source} | tags: ${e.tags.join(", ") || "none"}_`);
        lines.push("");
        lines.push(e.content);
        lines.push("");
      }
    }

    // Track access on all briefing entries
    for (const e of entries) {
      e.accessCount++;
      e.lastAccessedAt = now.toISOString();
    }
    this.scheduleSave();

    return lines.join("\n");
  }

  /** Stats about the KB */
  stats(): {
    total: number;
    expired: number;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
    topTags: { tag: string; count: number }[];
  } {
    const now = new Date();
    const all = Array.from(this.entries.values());
    const expired = all.filter(e => e.expiresAt && new Date(e.expiresAt) <= now).length;

    const byType: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const tagCounts = new Map<string, number>();

    for (const e of all) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byPriority[e.priority] = (byPriority[e.priority] || 0) + 1;
      for (const t of e.tags) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
    }

    const topTags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    return { total: all.length, expired, byType, byPriority, topTags };
  }

  get size(): number {
    return this.entries.size;
  }
}
