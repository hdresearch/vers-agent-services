import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "agent" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  sender: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ChatMessageInput {
  role?: MessageRole;
  sender: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ── Store ──────────────────────────────────────────────────────────────────

export class ChatStore {
  private db: Database.Database;
  private sseListeners: Set<(msg: ChatMessage) => void> = new Set();

  constructor(dbPath = "data/chat.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'user',
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    `);
  }

  addMessage(input: ChatMessageInput): ChatMessage {
    const msg: ChatMessage = {
      id: ulid(),
      role: input.role || "user",
      sender: input.sender,
      content: input.content,
      timestamp: new Date().toISOString(),
      metadata: input.metadata,
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, role, sender, content, timestamp, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id,
        msg.role,
        msg.sender,
        msg.content,
        msg.timestamp,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
      );

    // Notify SSE listeners
    for (const listener of this.sseListeners) {
      try { listener(msg); } catch { /* ignore */ }
    }

    return msg;
  }

  getMessages(opts?: {
    limit?: number;
    since?: string;
    before?: string;
    sender?: string;
    role?: MessageRole;
  }): ChatMessage[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts?.since) {
      conditions.push("timestamp > ?");
      params.push(opts.since);
    }
    if (opts?.before) {
      conditions.push("timestamp < ?");
      params.push(opts.before);
    }
    if (opts?.sender) {
      conditions.push("sender = ?");
      params.push(opts.sender);
    }
    if (opts?.role) {
      conditions.push("role = ?");
      params.push(opts.role);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit || 100;

    // Get last N messages, ordered ascending
    const sql = `SELECT * FROM (
      SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ?
    ) sub ORDER BY timestamp ASC`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToMessage(r));
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any;
    return row ? this.rowToMessage(row) : null;
  }

  get messageCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as any;
    return row.cnt;
  }

  addListener(listener: (msg: ChatMessage) => void): () => void {
    this.sseListeners.add(listener);
    return () => this.sseListeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }

  private rowToMessage(row: any): ChatMessage {
    return {
      id: row.id,
      role: row.role as MessageRole,
      sender: row.sender,
      content: row.content,
      timestamp: row.timestamp,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}
