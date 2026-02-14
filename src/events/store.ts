import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// --- Types ---

export interface EventInput {
  source: string;
  type: string;
  payload: unknown;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface EventRecord {
  id: number;
  eventId: string;
  timestamp: string;
  source: string;
  type: string;
  agent: string | null;
  payload: unknown;
  metadata: Record<string, unknown> | null;
}

export interface EventFilters {
  source?: string;
  type?: string;
  agent?: string;
  since?: string;       // ISO timestamp or event_id (ULID)
  sinceId?: number;     // numeric auto-increment ID (for stream cursor)
  limit?: number;
}

export interface EventStats {
  total: number;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  oldest?: string;
  newest?: string;
}

// --- Errors ---

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

// --- Subscribers (for SSE stream) ---

type Subscriber = (event: EventRecord) => void;

// --- Store ---

export class EventLogStore {
  private db: Database.Database;
  private subscribers = new Set<Subscriber>();

  private insertStmt!: Database.Statement;
  private queryBaseStmt!: string;

  constructor(dbPath = "data/events.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT,
        payload JSON NOT NULL,
        metadata JSON
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type);
      CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source);
      CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_event_log_agent ON event_log(agent);
      CREATE INDEX IF NOT EXISTS idx_event_log_event_id ON event_log(event_id);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO event_log (event_id, timestamp, source, type, agent, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  append(input: EventInput): EventRecord {
    if (!input.source?.trim()) throw new ValidationError("source is required");
    if (!input.type?.trim()) throw new ValidationError("type is required");
    if (input.payload === undefined) throw new ValidationError("payload is required");

    const eventId = ulid();
    const timestamp = new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload);
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const result = this.insertStmt.run(
      eventId,
      timestamp,
      input.source.trim(),
      input.type.trim(),
      input.agent?.trim() || null,
      payloadJson,
      metadataJson,
    );

    const record: EventRecord = {
      id: result.lastInsertRowid as number,
      eventId,
      timestamp,
      source: input.source.trim(),
      type: input.type.trim(),
      agent: input.agent?.trim() || null,
      payload: input.payload,
      metadata: input.metadata || null,
    };

    // Notify subscribers
    for (const sub of this.subscribers) {
      try {
        sub(record);
      } catch {
        // Don't let subscriber errors break append
      }
    }

    return record;
  }

  query(filters: EventFilters = {}): EventRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.source) {
      conditions.push("source = ?");
      params.push(filters.source);
    }
    if (filters.type) {
      // Support wildcard: 'board.*' matches 'board.task.created', etc.
      if (filters.type.endsWith(".*")) {
        const prefix = filters.type.slice(0, -1); // 'board.'
        conditions.push("type LIKE ?");
        params.push(prefix + "%");
      } else {
        conditions.push("type = ?");
        params.push(filters.type);
      }
    }
    if (filters.agent) {
      conditions.push("agent = ?");
      params.push(filters.agent);
    }
    if (filters.since) {
      // If it looks like a ULID (26 chars, alphanumeric), filter by event_id
      if (/^[0-9A-Z]{26}$/i.test(filters.since)) {
        conditions.push("event_id > ?");
        params.push(filters.since);
      } else {
        // Assume ISO timestamp
        conditions.push("timestamp >= ?");
        params.push(filters.since);
      }
    }
    if (filters.sinceId !== undefined) {
      conditions.push("id > ?");
      params.push(filters.sinceId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit || 100;

    const rows = this.db
      .prepare(`SELECT * FROM event_log ${where} ORDER BY id ASC LIMIT ?`)
      .all(...params, limit) as any[];

    return rows.map(this.deserialize);
  }

  stats(): EventStats {
    const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM event_log").get() as any).cnt;

    const bySourceRows = this.db
      .prepare("SELECT source, COUNT(*) as cnt FROM event_log GROUP BY source")
      .all() as any[];
    const bySource: Record<string, number> = {};
    for (const r of bySourceRows) bySource[r.source] = r.cnt;

    const byTypeRows = this.db
      .prepare("SELECT type, COUNT(*) as cnt FROM event_log GROUP BY type")
      .all() as any[];
    const byType: Record<string, number> = {};
    for (const r of byTypeRows) byType[r.type] = r.cnt;

    const bounds = this.db
      .prepare("SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM event_log")
      .get() as any;

    return {
      total,
      bySource,
      byType,
      oldest: bounds?.oldest || undefined,
      newest: bounds?.newest || undefined,
    };
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Get the latest auto-increment ID (cursor for SSE stream) */
  latestId(): number {
    const row = this.db.prepare("SELECT MAX(id) as maxId FROM event_log").get() as any;
    return row?.maxId || 0;
  }

  close(): void {
    this.db.close();
  }

  private deserialize(row: any): EventRecord {
    return {
      id: row.id,
      eventId: row.event_id,
      timestamp: row.timestamp,
      source: row.source,
      type: row.type,
      agent: row.agent,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      metadata: row.metadata
        ? typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata
        : null,
    };
  }
}

// Singleton
export const eventLogStore = new EventLogStore();
