import { ulid } from "ulid";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  id: string;
  timestamp: string;
  text: string;
  author?: string;
  mood?: string;
  tags?: string[];
}

export interface AppendInput {
  text: string;
  author?: string;
  mood?: string;
  tags?: string[];
}

export interface QueryOptions {
  since?: string;
  until?: string;
  last?: string;
  author?: string;
  tag?: string;
}

function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return null;
}

export class JournalStore {
  private entries: JournalEntry[] = [];
  private filePath: string;

  constructor(filePath = "data/journal.jsonl") {
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
        const entry = JSON.parse(line) as JournalEntry;
        this.entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  append(input: AppendInput): JournalEntry {
    if (!input.text || typeof input.text !== "string" || !input.text.trim()) {
      throw new ValidationError("text is required");
    }

    const entry: JournalEntry = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      text: input.text.trim(),
    };
    if (input.author?.trim()) {
      entry.author = input.author.trim();
    }
    if (input.mood?.trim()) {
      entry.mood = input.mood.trim();
    }
    if (input.tags && Array.isArray(input.tags) && input.tags.length > 0) {
      entry.tags = input.tags.map((t) => t.trim()).filter(Boolean);
      if (entry.tags.length === 0) delete entry.tags;
    }

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");

    this.entries.push(entry);
    return entry;
  }

  query(opts: QueryOptions = {}): JournalEntry[] {
    let sinceTime: number | undefined;
    let untilTime: number | undefined;

    if (opts.last) {
      const ms = parseDuration(opts.last);
      if (ms !== null) {
        sinceTime = Date.now() - ms;
      }
    }
    if (opts.since) {
      sinceTime = new Date(opts.since).getTime();
    }
    if (opts.until) {
      untilTime = new Date(opts.until).getTime();
    }

    if (sinceTime === undefined && untilTime === undefined) {
      sinceTime = Date.now() - 24 * 60 * 60 * 1000;
    }

    let result = this.entries;

    if (sinceTime !== undefined) {
      result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceTime!);
    }
    if (untilTime !== undefined) {
      result = result.filter((e) => new Date(e.timestamp).getTime() <= untilTime!);
    }
    if (opts.author) {
      const author = opts.author.toLowerCase();
      result = result.filter((e) => (e.author || "").toLowerCase() === author);
    }
    if (opts.tag) {
      const tag = opts.tag.toLowerCase();
      result = result.filter((e) => (e.tags || []).some((t) => t.toLowerCase() === tag));
    }

    return result;
  }

  formatRaw(entries: JournalEntry[]): string {
    return entries
      .map((e) => {
        const author = e.author ? ` (${e.author})` : "";
        const mood = e.mood ? ` [${e.mood}]` : "";
        const tags = e.tags?.length ? ` #${e.tags.join(" #")}` : "";
        return `[${e.timestamp}]${author}${mood}${tags} ${e.text}`;
      })
      .join("\n");
  }

  get size(): number {
    return this.entries.length;
  }
}

export { ValidationError } from "../errors.js";
import { ValidationError } from "../errors.js";
