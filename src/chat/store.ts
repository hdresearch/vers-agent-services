import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type ChatRole = "human" | "system" | "agent" | "bridge";

export interface WebChatMessage {
  id: string;
  role: ChatRole;
  sender: string;
  content: string;
  command?: string;       // parsed command name (e.g. "spawn", "status")
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PostMessageInput {
  role: ChatRole;
  sender: string;
  content: string;
  command?: string;
  metadata?: Record<string, unknown>;
}

// ── Store ──────────────────────────────────────────────────────────────────

export class WebChatStore {
  private db: Database.Database;
  private listeners: Set<(msg: WebChatMessage) => void> = new Set();

  constructor(dbPath = "data/web-chat.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
        role TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        command TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_createdAt ON messages(createdAt);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
    `);
  }

  post(input: PostMessageInput): WebChatMessage {
    const msg: WebChatMessage = {
      id: ulid(),
      role: input.role,
      sender: input.sender,
      content: input.content,
      command: input.command,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(
      `INSERT INTO messages (id, role, sender, content, command, metadata, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      msg.id, msg.role, msg.sender, msg.content,
      msg.command || null,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
      msg.createdAt,
    );

    // Notify SSE listeners
    for (const listener of this.listeners) {
      try { listener(msg); } catch { /* ignore */ }
    }

    return msg;
  }

  list(opts?: { limit?: number; after?: string; before?: string; role?: ChatRole }): WebChatMessage[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.role) {
      conditions.push("role = ?");
      params.push(opts.role);
    }
    if (opts?.after) {
      conditions.push("createdAt > ?");
      params.push(opts.after);
    }
    if (opts?.before) {
      conditions.push("createdAt < ?");
      params.push(opts.before);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit || 100;

    const sql = `SELECT * FROM (
      SELECT * FROM messages ${where} ORDER BY createdAt DESC LIMIT ?
    ) sub ORDER BY createdAt ASC`;

    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToMessage(r));
  }

  get(id: string): WebChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any;
    return row ? this.rowToMessage(row) : null;
  }

  addListener(fn: (msg: WebChatMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get count(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as any).cnt;
  }

  close(): void {
    this.db.close();
  }

  private rowToMessage(row: any): WebChatMessage {
    return {
      id: row.id,
      role: row.role as ChatRole,
      sender: row.sender,
      content: row.content,
      command: row.command || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.createdAt,
    };
  }
}
