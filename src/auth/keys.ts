import Database from "better-sqlite3";
import { ulid } from "ulid";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  scopes: string; // JSON array stored as text
}

export interface ApiKeyPublic {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  scopes: string[];
}

export interface CreateApiKeyInput {
  name: string;
  scopes?: string[];
}

export interface CreateApiKeyResult {
  key: ApiKeyPublic;
  rawKey: string;
}

/** Hash a raw API key with SHA-256 */
export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a new raw API key: `vk_<32 random hex bytes>` */
export function generateKey(): string {
  return `vk_${randomBytes(32).toString("hex")}`;
}

function toPublic(row: ApiKey): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    scopes: JSON.parse(row.scopes),
  };
}

export class ApiKeyStore {
  private db: Database.Database;

  constructor(dbPath = "data/api-keys.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        scopes TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
    `);
  }

  create(input: CreateApiKeyInput): CreateApiKeyResult {
    const rawKey = generateKey();
    const id = ulid();
    const now = new Date().toISOString();
    const scopes = input.scopes ?? [];

    const row: ApiKey = {
      id,
      name: input.name,
      key_hash: hashKey(rawKey),
      key_prefix: rawKey.slice(0, 7), // "vk_xxxx"
      created_at: now,
      revoked_at: null,
      scopes: JSON.stringify(scopes),
    };

    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, revoked_at, scopes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.name, row.key_hash, row.key_prefix, row.created_at, row.revoked_at, row.scopes);

    return { key: toPublic(row), rawKey };
  }

  /** Look up a key by its raw value. Returns null if not found or revoked. */
  verify(rawKey: string): ApiKeyPublic | null {
    const hash = hashKey(rawKey);
    const row = this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
      .get(hash) as ApiKey | undefined;

    if (!row) return null;
    if (row.revoked_at) return null;
    return toPublic(row);
  }

  list(): ApiKeyPublic[] {
    const rows = this.db
      .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
      .all() as ApiKey[];
    return rows.map(toPublic);
  }

  revoke(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, id);
    return result.changes > 0;
  }

  getById(id: string): ApiKeyPublic | null {
    const row = this.db
      .prepare("SELECT * FROM api_keys WHERE id = ?")
      .get(id) as ApiKey | undefined;
    if (!row) return null;
    return toPublic(row);
  }

  close(): void {
    this.db.close();
  }
}
