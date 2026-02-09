import { ulid } from "ulid";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type FeedEventType =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "blocker_found"
  | "question"
  | "finding"
  | "skill_proposed"
  | "file_changed"
  | "cost_update"
  | "agent_started"
  | "agent_stopped"
  | "custom";

export const VALID_EVENT_TYPES: Set<string> = new Set([
  "task_started",
  "task_completed",
  "task_failed",
  "blocker_found",
  "question",
  "finding",
  "skill_proposed",
  "file_changed",
  "cost_update",
  "agent_started",
  "agent_stopped",
  "custom",
]);

export interface FeedEvent {
  id: string;
  agent: string;
  type: FeedEventType;
  summary: string;
  detail?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface PublishInput {
  agent: string;
  type: FeedEventType;
  summary: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface FilterOptions {
  agent?: string;
  type?: string;
  since?: string; // ISO timestamp or ULID
  limit?: number;
}

type Subscriber = (event: FeedEvent) => void;

export class FeedStore {
  private events: FeedEvent[] = [];
  private subscribers: Set<Subscriber> = new Set();
  private filePath: string;
  private maxInMemory: number;

  constructor(filePath = "data/feed.jsonl", maxInMemory = 10000) {
    this.filePath = filePath;
    this.maxInMemory = maxInMemory;
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
        const event = JSON.parse(line) as FeedEvent;
        this.events.push(event);
      } catch {
        // skip malformed lines
      }
    }
    // Keep only last N in memory
    if (this.events.length > this.maxInMemory) {
      this.events = this.events.slice(-this.maxInMemory);
    }
  }

  publish(input: PublishInput): FeedEvent {
    const event: FeedEvent = {
      id: ulid(),
      agent: input.agent,
      type: input.type,
      summary: input.summary,
      timestamp: new Date().toISOString(),
    };
    if (input.detail !== undefined) event.detail = input.detail;
    if (input.metadata !== undefined) event.metadata = input.metadata;

    // Append to file immediately
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");

    // Add to memory
    this.events.push(event);
    if (this.events.length > this.maxInMemory) {
      this.events = this.events.slice(-this.maxInMemory);
    }

    // Notify subscribers
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }

    return event;
  }

  get(id: string): FeedEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  list(opts: FilterOptions = {}): FeedEvent[] {
    let result = this.events;

    if (opts.agent) {
      result = result.filter((e) => e.agent === opts.agent);
    }
    if (opts.type) {
      result = result.filter((e) => e.type === opts.type);
    }
    if (opts.since) {
      const since = opts.since;
      // If it looks like a ULID (26 chars, alphanumeric), compare by ID
      if (/^[0-9A-Z]{26}$/i.test(since)) {
        result = result.filter((e) => e.id > since);
      } else {
        // Treat as ISO timestamp
        const sinceTime = new Date(since).getTime();
        result = result.filter((e) => new Date(e.timestamp).getTime() > sinceTime);
      }
    }

    const limit = opts.limit ?? 50;
    if (limit > 0) {
      result = result.slice(-limit);
    }

    return result;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Get events after a specific ULID (for SSE reconnection replay).
   */
  eventsSince(sinceId: string, agent?: string): FeedEvent[] {
    let result = this.events.filter((e) => e.id > sinceId);
    if (agent) {
      result = result.filter((e) => e.agent === agent);
    }
    return result;
  }

  stats(): {
    total: number;
    byAgent: Record<string, number>;
    byType: Record<string, number>;
    latestPerAgent: Record<string, FeedEvent>;
  } {
    const byAgent: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const latestPerAgent: Record<string, FeedEvent> = {};

    for (const event of this.events) {
      byAgent[event.agent] = (byAgent[event.agent] || 0) + 1;
      byType[event.type] = (byType[event.type] || 0) + 1;
      // Since events are ordered by ULID, last one wins
      latestPerAgent[event.agent] = event;
    }

    return {
      total: this.events.length,
      byAgent,
      byType,
      latestPerAgent,
    };
  }

  clear(): void {
    this.events = [];
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, "");
  }

  get size(): number {
    return this.events.length;
  }
}
