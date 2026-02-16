import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// --- Types ---

export type ActionType =
  | "spawn_agent"
  | "restart_service"
  | "close_task"
  | "reassign_task"
  | "kill_guest"
  | "log_event"
  | "alert";

export interface DaemonAction {
  id: string;
  timestamp: string;
  actionType: ActionType;
  trigger: string;         // the event type that caused this
  triggerEventId: string;   // event ID that triggered
  description: string;      // human-readable "what and why"
  result: "success" | "failure" | "pending";
  resultDetail: string | null;
  metadata: Record<string, unknown> | null;
}

export interface DaemonState {
  running: boolean;
  startedAt: string | null;
  lastPollAt: string | null;
  lastActionAt: string | null;
  lastEventCursor: number;   // auto-increment ID from event_log
  pendingEvents: number;
}

// --- Store ---

export class DaemonStore {
  private db: Database.Database;

  constructor(dbPath = "data/daemon.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_actions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        action_type TEXT NOT NULL,
        trigger TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL,
        description TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT 'pending',
        result_detail TEXT,
        metadata JSON
      );

      CREATE INDEX IF NOT EXISTS idx_daemon_actions_ts ON daemon_actions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_daemon_actions_type ON daemon_actions(action_type);

      CREATE TABLE IF NOT EXISTS daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Ensure defaults exist
    const upsert = this.db.prepare(
      "INSERT OR IGNORE INTO daemon_state (key, value) VALUES (?, ?)"
    );
    upsert.run("running", "false");
    upsert.run("started_at", "");
    upsert.run("last_poll_at", "");
    upsert.run("last_action_at", "");
    upsert.run("last_event_cursor", "0");
  }

  // --- State ---

  getState(): DaemonState {
    const rows = this.db.prepare("SELECT key, value FROM daemon_state").all() as {
      key: string;
      value: string;
    }[];
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return {
      running: map.running === "true",
      startedAt: map.started_at || null,
      lastPollAt: map.last_poll_at || null,
      lastActionAt: map.last_action_at || null,
      lastEventCursor: parseInt(map.last_event_cursor || "0", 10),
      pendingEvents: 0, // filled by engine
    };
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)").run(
      key,
      value,
    );
  }

  // --- Actions ---

  recordAction(input: {
    actionType: ActionType;
    trigger: string;
    triggerEventId: string;
    description: string;
    result?: "success" | "failure" | "pending";
    resultDetail?: string;
    metadata?: Record<string, unknown>;
  }): DaemonAction {
    const id = ulid();
    const timestamp = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO daemon_actions (id, timestamp, action_type, trigger, trigger_event_id, description, result, result_detail, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        timestamp,
        input.actionType,
        input.trigger,
        input.triggerEventId,
        input.description,
        input.result || "pending",
        input.resultDetail || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );

    return {
      id,
      timestamp,
      actionType: input.actionType,
      trigger: input.trigger,
      triggerEventId: input.triggerEventId,
      description: input.description,
      result: input.result || "pending",
      resultDetail: input.resultDetail || null,
      metadata: input.metadata || null,
    };
  }

  updateActionResult(id: string, result: "success" | "failure", detail: string): void {
    this.db
      .prepare("UPDATE daemon_actions SET result = ?, result_detail = ? WHERE id = ?")
      .run(result, detail, id);
  }

  getActions(limit = 50): DaemonAction[] {
    const rows = this.db
      .prepare("SELECT * FROM daemon_actions ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      actionType: r.action_type,
      trigger: r.trigger,
      triggerEventId: r.trigger_event_id,
      description: r.description,
      result: r.result,
      resultDetail: r.result_detail,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    }));
  }

  getActionCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM daemon_actions").get() as any).cnt;
  }

  close(): void {
    this.db.close();
  }
}
