import { ulid } from "ulid";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface LogEntry {
  id: string;
  timestamp: string;
  text: string;
  agent?: string;
}

export interface AppendInput {
  text: string;
  agent?: string;
}

export interface QueryOptions {
  since?: string; // ISO timestamp
  until?: string; // ISO timestamp
  last?: string;  // e.g. "24h", "7d", "30d"
}

/**
 * Parse a duration string like "24h", "7d", "30d" into milliseconds.
 */
function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return null;
}

export class LogStore {
  private entries: LogEntry[] = [];
  private filePath: string;

  constructor(filePath = "data/log.jsonl") {
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
        const entry = JSON.parse(line) as LogEntry;
        this.entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  append(input: AppendInput): LogEntry {
    if (!input.text || typeof input.text !== "string" || !input.text.trim()) {
      throw new ValidationError("text is required");
    }

    const entry: LogEntry = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      text: input.text.trim(),
    };
    if (input.agent?.trim()) {
      entry.agent = input.agent.trim();
    }

    // Append to file immediately — O(1), no read-modify-write
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");

    // Add to memory
    this.entries.push(entry);

    return entry;
  }

  query(opts: QueryOptions = {}): LogEntry[] {
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

    // Default: last 24h if no time constraints given
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

    // Already in chronological order (append-only)
    return result;
  }

  /**
   * Format entries as plain text for piping into models.
   * Format: [2026-02-10T15:30:00Z] (agent) text
   */
  formatRaw(entries: LogEntry[]): string {
    return entries
      .map((e) => {
        const agent = e.agent ? ` (${e.agent})` : "";
        return `[${e.timestamp}]${agent} ${e.text}`;
      })
      .join("\n");
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
