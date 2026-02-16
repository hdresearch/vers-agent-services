import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";

// --- Types ---

export type EntryType = "warning" | "convention" | "lesson" | "context" | "fact";

export const VALID_ENTRY_TYPES = new Set<string>([
  "warning",
  "convention",
  "lesson",
  "context",
  "fact",
]);

/** Default decay days per entry type */
export const DEFAULT_DECAY_DAYS: Record<EntryType, number> = {
  warning: 7,
  convention: 90,
  lesson: 30,
  context: 14,
  fact: 365,
};

export interface KBEntry {
  id: string;
  type: EntryType;
  content: string;
  source?: string;
  tags: string[];
  confidence: number;       // 1-10, bumped on reinforcement
  decayDays: number;        // TTL in days from lastReinforced
  lastReinforced: string;   // ISO timestamp — decay counts from here
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface CreateEntryInput {
  type: EntryType;
  content: string;
  source?: string;
  tags?: string[];
  confidence?: number;
  decayDays?: number;
}

export interface UpdateEntryInput {
  content?: string;
  source?: string;
  tags?: string[];
  confidence?: number;
  decayDays?: number;
  archived?: boolean;
  reinforce?: boolean;       // Reset decay timer, bump confidence
}

export interface EntryFilters {
  type?: EntryType;
  tag?: string;
  active?: boolean;          // true = not expired & not archived
  archived?: boolean;
  search?: string;           // full-text search on content
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

  /** Check if an entry has expired based on its decay window */
  isExpired(entry: KBEntry): boolean {
    const decayMs = entry.decayDays * 24 * 60 * 60 * 1000;
    const reinforcedAt = new Date(entry.lastReinforced).getTime();
    return Date.now() > reinforcedAt + decayMs;
  }

  /** Check if an entry is active (not expired AND not archived) */
  isActive(entry: KBEntry): boolean {
    return !entry.archived && !this.isExpired(entry);
  }

  /** Rough token estimate (~4 chars per token) */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // --- CRUD ---

  createEntry(input: CreateEntryInput): KBEntry {
    if (!input.content || typeof input.content !== "string" || !input.content.trim()) {
      throw new ValidationError("content is required");
    }
    if (!input.type || !VALID_ENTRY_TYPES.has(input.type)) {
      throw new ValidationError(`invalid type: ${input.type}. Must be one of: ${[...VALID_ENTRY_TYPES].join(", ")}`);
    }
    if (input.confidence !== undefined && (input.confidence < 1 || input.confidence > 10)) {
      throw new ValidationError("confidence must be between 1 and 10");
    }

    const now = new Date().toISOString();
    const entry: KBEntry = {
      id: ulid(),
      type: input.type,
      content: input.content.trim(),
      source: input.source?.trim(),
      tags: input.tags || [],
      confidence: input.confidence || 5,
      decayDays: input.decayDays ?? DEFAULT_DECAY_DAYS[input.type],
      lastReinforced: now,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };

    this.entries.set(entry.id, entry);
    this.scheduleSave();
    return entry;
  }

  getEntry(id: string): KBEntry | undefined {
    return this.entries.get(id);
  }

  updateEntry(id: string, input: UpdateEntryInput): KBEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundError(`entry ${id} not found`);

    const now = new Date().toISOString();

    if (input.content !== undefined) entry.content = input.content.trim();
    if (input.source !== undefined) entry.source = input.source.trim();
    if (input.tags !== undefined) entry.tags = input.tags;
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

  listEntries(filters?: EntryFilters): KBEntry[] {
    let results = Array.from(this.entries.values());

    if (filters?.type) {
      results = results.filter((e) => e.type === filters.type);
    }
    if (filters?.tag) {
      results = results.filter((e) => e.tags.includes(filters.tag!));
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
          e.tags.some((t) => t.toLowerCase().includes(q)) ||
          (e.source && e.source.toLowerCase().includes(q)),
      );
    }

    // Sort by confidence desc, then by updatedAt desc
    results.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    return results;
  }

  // --- Briefings ---

  /** Build a composed session briefing within a token budget */
  sessionBriefing(maxTokens = 4000): string {
    const sections: string[] = [];
    let tokenBudget = maxTokens;

    const addSection = (title: string, entries: KBEntry[], budget: number): number => {
      if (entries.length === 0) return budget;
      const lines: string[] = [`## ${title}`];
      for (const e of entries) {
        const line = `- ${e.content}${e.source ? ` [source: ${e.source}]` : ""}`;
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
      this.listEntries({ type, active: true });

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

    // Get active entries matching any of the provided tags
    const matchingEntries = Array.from(this.entries.values()).filter((e) => {
      if (!this.isActive(e)) return false;
      return tags.some((t) => e.tags.includes(t));
    });

    // Also always include active warnings (critical regardless of tags)
    const warnings = this.listEntries({ type: "warning", active: true });

    const addSection = (title: string, entries: KBEntry[], budget: number): number => {
      if (entries.length === 0) return budget;
      const lines: string[] = [`## ${title}`];
      for (const e of entries) {
        const matchedTags = e.tags.filter((t) => tags.includes(t));
        const tagNote = matchedTags.length > 0 ? ` [${matchedTags.join(", ")}]` : "";
        const line = `- ${e.content}${tagNote}${e.source ? ` (source: ${e.source})` : ""}`;
        const cost = this.estimateTokens(line);
        if (budget - cost < 0) break;
        lines.push(line);
        budget -= cost;
      }
      if (lines.length > 1) sections.push(lines.join("\n"));
      return budget;
    };

    tokenBudget = addSection("⚠️ Warnings", warnings, tokenBudget);

    // Group remaining by type
    const byType = new Map<EntryType, KBEntry[]>();
    for (const e of matchingEntries) {
      if (e.type === "warning") continue; // already included
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
    };

    for (const type of ["context", "convention", "lesson", "fact"] as EntryType[]) {
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

      // Pattern: WARNING/WARN/⚠️ prefix
      if (/^(WARNING|WARN|⚠️)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "warning",
          content: trimmed.replace(/^(WARNING|WARN|⚠️)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      // Pattern: CONVENTION/RULE prefix
      if (/^(CONVENTION|RULE)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "convention",
          content: trimmed.replace(/^(CONVENTION|RULE)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      // Pattern: LESSON/LEARNED prefix
      if (/^(LESSON|LEARNED|TIL)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "lesson",
          content: trimmed.replace(/^(LESSON|LEARNED|TIL)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      // Pattern: CONTEXT prefix
      if (/^(CONTEXT|NOTE)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "context",
          content: trimmed.replace(/^(CONTEXT|NOTE)[:\s]+/i, "").trim(),
          source,
          tags: ["extracted"],
        });
        continue;
      }

      // Pattern: FACT prefix
      if (/^(FACT)[:\s]/i.test(trimmed)) {
        extracted.push({
          type: "fact",
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
  } {
    const all = Array.from(this.entries.values());
    const byType: Record<string, number> = {};
    let active = 0;
    let expired = 0;
    let archived = 0;

    for (const e of all) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.archived) archived++;
      else if (this.isExpired(e)) expired++;
      else active++;
    }

    return { total: all.length, active, expired, archived, byType };
  }
}
