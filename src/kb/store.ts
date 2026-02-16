import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";

// --- Types ---

export type EntryType = "warning" | "convention" | "lesson" | "context" | "fact" | "gotcha" | "reference" | "sop";

export const VALID_ENTRY_TYPES = new Set<string>([
  "warning",
  "convention",
  "lesson",
  "context",
  "fact",
  "gotcha",
  "reference",
  "sop",
]);

export type Priority = "low" | "normal" | "high" | "critical";

const VALID_PRIORITIES = new Set<string>(["low", "normal", "high", "critical"]);

/** Priority sort order (higher = more important) */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** Default decay days per entry type */
export const DEFAULT_DECAY_DAYS: Record<EntryType, number> = {
  warning: 7,
  convention: 90,
  lesson: 30,
  context: 14,
  fact: 365,
  gotcha: 14,
  reference: 365,
  sop: 180,
};

export interface KBEntry {
  id: string;
  type: EntryType;
  title: string;
  content: string;
  source?: string;
  tags: string[];
  priority: Priority;
  accessCount: number;
  expiresAt: string | null;
  confidence: number;       // 1-10, bumped on reinforcement
  decayDays: number;        // TTL in days from lastReinforced
  lastReinforced: string;   // ISO timestamp — decay counts from here
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface CreateEntryInput {
  type: EntryType;
  title?: string;
  content: string;
  source?: string;
  tags?: string[];
  confidence?: number;
  priority?: Priority;
  decayDays?: number;
}

export interface UpdateEntryInput {
  title?: string;
  content?: string;
  source?: string;
  tags?: string[];
  confidence?: number;
  priority?: Priority;
  decayDays?: number;
  archived?: boolean;
  reinforce?: boolean;       // Reset decay timer, bump confidence
}

export interface EntryFilters {
  type?: EntryType;
  tag?: string;
  priority?: Priority;
  active?: boolean;          // true = not expired & not archived
  archived?: boolean;
  search?: string;           // full-text search on content + title
  includeExpired?: boolean;
}

export interface BriefingOptions {
  tags?: string[];
  maxTokens?: number;        // approximate token budget (chars / 4)
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// --- Store ---

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
    const data = JSON.stringify(
      { entries: Array.from(this.entries.values()) },
      null,
      2,
    );
    atomicWriteFileSync(this.filePath, data);
  }

  // --- Helpers ---

  /** Check if an entry has expired based on its expiresAt or decay window */
  isExpired(entry: KBEntry): boolean {
    if (entry.expiresAt) {
      return new Date(entry.expiresAt).getTime() < Date.now();
    }
    // Check decay window from lastReinforced (decayDays=0 means immediate expiry)
    if (entry.decayDays !== undefined && entry.lastReinforced) {
      const decayMs = entry.decayDays * 24 * 60 * 60 * 1000;
      const reinforcedAt = new Date(entry.lastReinforced).getTime();
      return Date.now() > reinforcedAt + decayMs;
    }
    return false;
  }

  /** Check if an entry is active (not expired AND not archived) */
  isActive(entry: KBEntry): boolean {
    return !entry.archived && !this.isExpired(entry);
  }

  /** Rough token estimate (~4 chars per token) */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // --- v2 CRUD API (used by tests) ---

  create(input: CreateEntryInput): KBEntry {
    if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    if (!input.content || typeof input.content !== "string" || !input.content.trim()) {
      throw new ValidationError("content is required");
    }
    if (!input.type || !VALID_ENTRY_TYPES.has(input.type)) {
      throw new ValidationError(`invalid type: ${input.type}. type must be one of: ${[...VALID_ENTRY_TYPES].join(", ")}`);
    }
    if (input.priority && !VALID_PRIORITIES.has(input.priority)) {
      throw new ValidationError(`invalid priority: ${input.priority}. Must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
    }
    if (input.confidence !== undefined && (input.confidence < 1 || input.confidence > 10)) {
      throw new ValidationError("confidence must be between 1 and 10");
    }

    const now = new Date().toISOString();
    const hasExplicitDecay = input.decayDays !== undefined;
    const decayDays = hasExplicitDecay ? input.decayDays! : DEFAULT_DECAY_DAYS[input.type] || 30;

    // Compute expiresAt only when decayDays is explicitly provided
    let expiresAt: string | null = null;
    if (hasExplicitDecay && decayDays > 0) {
      expiresAt = new Date(Date.now() + decayDays * 24 * 60 * 60 * 1000).toISOString();
    } else if (hasExplicitDecay && decayDays < 0) {
      // Negative decayDays means already expired
      expiresAt = new Date(Date.now() + decayDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const entry: KBEntry = {
      id: ulid(),
      type: input.type,
      title: input.title.trim(),
      content: input.content.trim(),
      source: input.source?.trim(),
      tags: input.tags || [],
      priority: input.priority || "normal",
      accessCount: 0,
      expiresAt,
      confidence: input.confidence || 5,
      decayDays,
      lastReinforced: now,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };

    this.entries.set(entry.id, entry);
    this.scheduleSave();
    return entry;
  }

  get(id: string): KBEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundError(`entry ${id} not found`);
    entry.accessCount = (entry.accessCount || 0) + 1;
    this.scheduleSave();
    return entry;
  }

  update(id: string, input: UpdateEntryInput): KBEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundError(`entry ${id} not found`);

    const now = new Date().toISOString();

    if (input.title !== undefined) entry.title = input.title.trim();
    if (input.content !== undefined) entry.content = input.content.trim();
    if (input.source !== undefined) entry.source = input.source.trim();
    if (input.tags !== undefined) entry.tags = input.tags;
    if (input.priority !== undefined) {
      if (!VALID_PRIORITIES.has(input.priority)) {
        throw new ValidationError(`invalid priority: ${input.priority}`);
      }
      entry.priority = input.priority;
    }
    if (input.confidence !== undefined) {
      if (input.confidence < 1 || input.confidence > 10) {
        throw new ValidationError("confidence must be between 1 and 10");
      }
      entry.confidence = input.confidence;
    }
    if (input.decayDays !== undefined) entry.decayDays = input.decayDays;
    if (input.archived !== undefined) entry.archived = input.archived;

    // Reinforcement: reset decay timer and bump confidence
    if (input.reinforce) {
      entry.lastReinforced = now;
      entry.confidence = Math.min(10, entry.confidence + 1);
    }

    entry.updatedAt = now;
    this.entries.set(id, entry);
    this.scheduleSave();
    return entry;
  }

  delete(id: string): boolean {
    const existed = this.entries.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  list(filters?: EntryFilters): KBEntry[] {
    let results = Array.from(this.entries.values());

    // By default, exclude expired entries (unless includeExpired is true)
    if (!filters?.includeExpired) {
      results = results.filter((e) => !this.isExpired(e));
    }

    if (filters?.type) {
      results = results.filter((e) => e.type === filters.type);
    }
    if (filters?.tag) {
      results = results.filter((e) => e.tags.includes(filters.tag!));
    }
    if (filters?.priority) {
      results = results.filter((e) => e.priority === filters.priority);
    }
    if (filters?.active === true) {
      results = results.filter((e) => this.isActive(e));
    }
    if (filters?.active === false) {
      results = results.filter((e) => !this.isActive(e));
    }
    if (filters?.archived !== undefined) {
      results = results.filter((e) => e.archived === filters.archived);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      results = results.filter(
        (e) =>
          e.content.toLowerCase().includes(q) ||
          (e.title && e.title.toLowerCase().includes(q)) ||
          e.tags.some((t) => t.toLowerCase().includes(q)) ||
          (e.source && e.source.toLowerCase().includes(q)),
      );
    }

    // Sort by priority (critical > high > normal > low), then by updatedAt desc
    results.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] || 2;
      const pb = PRIORITY_ORDER[b.priority] || 2;
      if (pb !== pa) return pb - pa;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    return results;
  }

  // --- v1 API aliases (used by routes.ts) ---

  createEntry(input: CreateEntryInput): KBEntry {
    // If no title provided, use content as title (v1 compat - content was required, title was not)
    if (!input.title && input.content) {
      input.title = input.content.slice(0, 100);
    }
    return this.create(input);
  }

  getEntry(id: string): KBEntry | undefined {
    return this.entries.get(id);
  }

  updateEntry(id: string, input: UpdateEntryInput): KBEntry {
    return this.update(id, input);
  }

  listEntries(filters?: EntryFilters): KBEntry[] {
    // v1 behavior: don't auto-exclude expired unless explicitly filtering
    return this.list({ ...filters, includeExpired: true });
  }

  // --- Briefings ---

  /** Build a composed briefing for the fleet knowledge base */
  briefing(options?: BriefingOptions): string {
    let entries = Array.from(this.entries.values()).filter((e) => !this.isExpired(e) && !e.archived);

    if (entries.length === 0) return "";

    if (options?.tags && options.tags.length > 0) {
      entries = entries.filter((e) => e.tags.some((t) => options.tags!.includes(t)));
    }

    if (entries.length === 0) return "";

    const sections: string[] = ["# Fleet Knowledge Base\n"];

    // Critical knowledge first
    const critical = entries.filter((e) => e.priority === "critical");
    if (critical.length > 0) {
      sections.push("## 🚨 Critical Knowledge");
      for (const e of critical) {
        sections.push(`- **${e.title}**: ${e.content}`);
      }
      sections.push("");
    }

    // Group by type
    const byType = new Map<string, KBEntry[]>();
    for (const e of entries) {
      if (e.priority === "critical") continue; // already shown
      const list = byType.get(e.type) || [];
      list.push(e);
      byType.set(e.type, list);
    }

    const typeLabels: Record<string, string> = {
      warning: "⚠️ Warnings",
      gotcha: "⚠️ Gotchas",
      convention: "📐 Conventions",
      lesson: "💡 Lessons",
      context: "📋 Context",
      fact: "📌 Facts",
      reference: "📚 References",
      sop: "📋 SOPs",
    };

    for (const [type, label] of Object.entries(typeLabels)) {
      const typeEntries = byType.get(type);
      if (typeEntries && typeEntries.length > 0) {
        sections.push(`## ${label}`);
        for (const e of typeEntries) {
          sections.push(`- **${e.title}**: ${e.content}`);
        }
        sections.push("");
      }
    }

    return sections.join("\n").trim();
  }

  /** Build a composed session briefing within a token budget (v1 API) */
  sessionBriefing(maxTokens = 4000): string {
    const sections: string[] = [];
    let tokenBudget = maxTokens;

    const addSection = (title: string, entries: KBEntry[], budget: number): number => {
      if (entries.length === 0) return budget;
      const lines: string[] = [`## ${title}`];
      for (const e of entries) {
        const line = `- ${e.title || e.content}${e.source ? ` [source: ${e.source}]` : ""}`;
        const cost = this.estimateTokens(line);
        if (budget - cost < 0) break;
        lines.push(line);
        budget -= cost;
      }
      if (lines.length > 1) {
        sections.push(lines.join("\n"));
      }
      return budget;
    };

    // Priority order: warnings > context > conventions > lessons > facts
    const active = (type: EntryType) =>
      this.list({ type, active: true, includeExpired: false });

    tokenBudget = addSection("⚠️ Active Warnings", active("warning"), tokenBudget);
    tokenBudget = addSection("📋 Current Context", active("context"), tokenBudget);
    tokenBudget = addSection("📐 Conventions", active("convention"), tokenBudget);

    // Recent lessons: active + created in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentLessons = active("lesson").filter(
      (e) => e.createdAt >= sevenDaysAgo || e.updatedAt >= sevenDaysAgo,
    );
    tokenBudget = addSection("💡 Recent Lessons", recentLessons, tokenBudget);
    tokenBudget = addSection("📌 Facts", active("fact"), tokenBudget);

    if (sections.length === 0) {
      return "# Session Briefing\n\nNo active knowledge entries.";
    }
    return `# Session Briefing\n\n${sections.join("\n\n")}`;
  }

  /** Build a task-specific briefing filtered by tag relevance */
  taskBriefing(tags: string[], maxTokens = 4000): string {
    const sections: string[] = [];
    let tokenBudget = maxTokens;

    const matchingEntries = Array.from(this.entries.values()).filter((e) => {
      if (!this.isActive(e)) return false;
      return tags.some((t) => e.tags.includes(t));
    });

    const warnings = this.list({ type: "warning", active: true, includeExpired: false });

    const addSection = (title: string, entries: KBEntry[], budget: number): number => {
      if (entries.length === 0) return budget;
      const lines: string[] = [`## ${title}`];
      for (const e of entries) {
        const matchedTags = e.tags.filter((t) => tags.includes(t));
        const tagNote = matchedTags.length > 0 ? ` [${matchedTags.join(", ")}]` : "";
        const line = `- ${e.title || e.content}${tagNote}${e.source ? ` (source: ${e.source})` : ""}`;
        const cost = this.estimateTokens(line);
        if (budget - cost < 0) break;
        lines.push(line);
        budget -= cost;
      }
      if (lines.length > 1) sections.push(lines.join("\n"));
      return budget;
    };

    tokenBudget = addSection("⚠️ Warnings", warnings, tokenBudget);

    const byType = new Map<EntryType, KBEntry[]>();
    for (const e of matchingEntries) {
      if (e.type === "warning") continue;
      const list = byType.get(e.type) || [];
      list.push(e);
      byType.set(e.type, list);
    }

    const typeLabels: Record<EntryType, string> = {
      context: "📋 Context",
      convention: "📐 Conventions",
      lesson: "💡 Lessons",
      fact: "📌 Facts",
      warning: "⚠️ Warnings",
      gotcha: "⚠️ Gotchas",
      reference: "📚 References",
      sop: "📋 SOPs",
    };

    for (const type of ["context", "convention", "lesson", "fact", "gotcha", "reference", "sop"] as EntryType[]) {
      const entries = byType.get(type);
      if (entries) {
        tokenBudget = addSection(typeLabels[type], entries, tokenBudget);
      }
    }

    if (sections.length === 0) {
      return `# Task Briefing [${tags.join(", ")}]\n\nNo relevant knowledge entries for these tags.`;
    }
    return `# Task Briefing [${tags.join(", ")}]\n\n${sections.join("\n\n")}`;
  }

  /** Extract knowledge entries from raw text (simple pattern-based extraction) */
  extractFromText(text: string, source?: string): CreateEntryInput[] {
    const extracted: CreateEntryInput[] = [];
    const lines = text.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 10) continue;

      if (/^(WARNING|WARN|⚠️)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "warning",
          title: trimmed.replace(/^(WARNING|WARN|⚠️)[:\s]+/i, "").trim().slice(0, 100),
          content: trimmed.replace(/^(WARNING|WARN|⚠️)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      if (/^(CONVENTION|RULE)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "convention",
          title: trimmed.replace(/^(CONVENTION|RULE)[:\s]+/i, "").trim().slice(0, 100),
          content: trimmed.replace(/^(CONVENTION|RULE)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      if (/^(LESSON|LEARNED|TIL)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "lesson",
          title: trimmed.replace(/^(LESSON|LEARNED|TIL)[:\s]+/i, "").trim().slice(0, 100),
          content: trimmed.replace(/^(LESSON|LEARNED|TIL)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      if (/^(CONTEXT|NOTE)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "context",
          title: trimmed.replace(/^(CONTEXT|NOTE)[:\s]+/i, "").trim().slice(0, 100),
          content: trimmed.replace(/^(CONTEXT|NOTE)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      if (/^(FACT)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "fact",
          title: trimmed.replace(/^(FACT)[:\s]+/i, "").trim().slice(0, 100),
          content: trimmed.replace(/^(FACT)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }
    }

    return extracted;
  }

  /** Get store stats */
  stats(): {
    total: number;
    active: number;
    expired: number;
    archived: number;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
    topTags: Array<{ tag: string; count: number }>;
  } {
    const all = Array.from(this.entries.values());
    const byType: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const tagCounts = new Map<string, number>();
    let active = 0;
    let expired = 0;
    let archived = 0;

    for (const e of all) {
      byType[e.type] = (byType[e.type] || 0) + 1;

      const p = e.priority || "normal";
      byPriority[p] = (byPriority[p] || 0) + 1;

      for (const tag of e.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }

      if (e.archived) archived++;
      else if (this.isExpired(e)) expired++;
      else active++;
    }

    const topTags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return { total: all.length, active, expired, archived, byType, byPriority, topTags };
  }

  get size(): number {
    return this.entries.size;
  }
}
