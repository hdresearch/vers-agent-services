import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface ConfigEntry {
  key: string;
  value: string;
  type: "config" | "secret";
  updatedAt: string;
}

export interface ConfigEntryMasked {
  key: string;
  value: string;
  type: "config" | "secret";
  updatedAt: string;
}

const VALID_TYPES = new Set(["config", "secret"]);

const DEFAULT_ENTRIES: Array<{ key: string; type: "config" | "secret"; value?: string }> = [
  { key: "ANTHROPIC_API_KEY", type: "secret" },
  { key: "VERS_API_KEY", type: "secret" },
  { key: "VERS_AUTH_TOKEN", type: "secret" },
  { key: "VERS_INFRA_URL", type: "config" },
  { key: "GITHUB_TOKEN", type: "secret" },
  { key: "GIT_EDITOR", type: "config", value: "true" },
];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function maskValue(value: string): string {
  if (!value || value.length <= 6) return "***";
  return value.slice(0, 6) + "***";
}

export class ConfigStore {
  private db: Database.Database;

  constructor(dbPath = "data/config.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('config', 'secret')),
        updated_at TEXT NOT NULL
      )
    `);

    // Pre-seed defaults if table is empty
    const count = this.db.prepare("SELECT COUNT(*) as cnt FROM config").get() as { cnt: number };
    if (count.cnt === 0) {
      this.seed();
    }
  }

  private seed(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO config (key, value, type, updated_at) VALUES (?, ?, ?, ?)"
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const entry of DEFAULT_ENTRIES) {
        // Try to read from env, fall back to empty string
        const envValue = entry.value ?? process.env[entry.key] ?? "";
        insert.run(entry.key, envValue, entry.type, now);
      }
    });
    tx();
  }

  set(key: string, value: string, type: "config" | "secret"): ConfigEntry {
    if (!key || typeof key !== "string" || !key.trim()) {
      throw new ValidationError("key is required");
    }
    if (typeof value !== "string") {
      throw new ValidationError("value must be a string");
    }
    if (!VALID_TYPES.has(type)) {
      throw new ValidationError("type must be 'config' or 'secret'");
    }

    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO config (key, value, type, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, type = ?, updated_at = ?"
    ).run(key, value, type, now, value, type, now);

    return { key, value, type, updatedAt: now };
  }

  get(key: string): ConfigEntry | null {
    const row = this.db.prepare(
      "SELECT key, value, type, updated_at as updatedAt FROM config WHERE key = ?"
    ).get(key) as { key: string; value: string; type: "config" | "secret"; updatedAt: string } | undefined;

    if (!row) return null;
    return row;
  }

  getAll(): ConfigEntry[] {
    return this.db.prepare(
      "SELECT key, value, type, updated_at as updatedAt FROM config ORDER BY key"
    ).all() as ConfigEntry[];
  }

  delete(key: string): boolean {
    const result = this.db.prepare("DELETE FROM config WHERE key = ?").run(key);
    return result.changes > 0;
  }

  getMasked(entry: ConfigEntry): ConfigEntryMasked {
    return {
      ...entry,
      value: entry.type === "secret" ? maskValue(entry.value) : entry.value,
    };
  }

  getAllMasked(): ConfigEntryMasked[] {
    return this.getAll().map((e) => this.getMasked(e));
  }

  getEnv(): Record<string, string> {
    const entries = this.getAll();
    const env: Record<string, string> = {};
    for (const e of entries) {
      env[e.key] = e.value;
    }
    return env;
  }

  close(): void {
    this.db.close();
  }

  get size(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM config").get() as { cnt: number };
    return row.cnt;
  }
}
