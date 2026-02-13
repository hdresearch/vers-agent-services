import { ulid } from "ulid";
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface MagicLink {
  token: string;
  expiresAt: string;
  used: boolean;
}

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

const MAGIC_LINK_TTL = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// Magic links stay in-memory (they're short-lived, 5 min)
const magicLinks = new Map<string, MagicLink>();

// ---------------------------------------------------------------------------
// SQLite session store
// ---------------------------------------------------------------------------

const DB_PATH = "data/sessions.db";

function ensureDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  return db;
}

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = ensureDb();
  }
  return db;
}

// In-memory cache for fast validation (loaded from SQLite on startup)
const sessions = new Map<string, Session>();

// Load valid sessions from SQLite into memory
function loadSessions(): void {
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare("SELECT token, created_at, expires_at FROM sessions WHERE expires_at > ?")
    .all(now) as Array<{ token: string; created_at: string; expires_at: string }>;
  for (const row of rows) {
    sessions.set(row.token, {
      id: row.token,
      createdAt: new Date(row.created_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
    });
  }
}

// Initialize on module load
loadSessions();

export function createMagicLink(): MagicLink {
  const token = ulid() + ulid(); // long random token
  const link: MagicLink = {
    token,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL).toISOString(),
    used: false,
  };
  magicLinks.set(token, link);
  return link;
}

export function consumeMagicLink(token: string): boolean {
  const link = magicLinks.get(token);
  if (!link) return false;
  if (link.used) return false;
  if (new Date(link.expiresAt).getTime() < Date.now()) {
    magicLinks.delete(token);
    return false;
  }
  link.used = true;
  magicLinks.delete(token);
  return true;
}

export function createSession(): Session {
  const id = ulid();
  const now = Date.now();
  const session: Session = {
    id,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  };

  // Persist to SQLite
  getDb()
    .prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)")
    .run(id, new Date(now).toISOString(), new Date(session.expiresAt).toISOString());

  // Cache in memory
  sessions.set(id, session);
  return session;
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;

  // Check in-memory cache first
  const cached = sessions.get(sessionId);
  if (cached) {
    if (cached.expiresAt < Date.now()) {
      sessions.delete(sessionId);
      getDb().prepare("DELETE FROM sessions WHERE token = ?").run(sessionId);
      return false;
    }
    return true;
  }

  // Fallback: check SQLite directly (in case cache missed it)
  const row = getDb()
    .prepare("SELECT token, created_at, expires_at FROM sessions WHERE token = ? AND expires_at > datetime('now')")
    .get(sessionId) as { token: string; created_at: string; expires_at: string } | undefined;

  if (!row) return false;

  // Re-cache
  sessions.set(row.token, {
    id: row.token,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
  });
  return true;
}

// Cleanup expired entries periodically
function cleanupExpired(): void {
  const now = Date.now();

  // Clean magic links (in-memory only)
  for (const [k, v] of magicLinks) {
    if (new Date(v.expiresAt).getTime() < now) magicLinks.delete(k);
  }

  // Clean sessions from memory and SQLite
  for (const [k, v] of sessions) {
    if (v.expiresAt < now) sessions.delete(k);
  }

  getDb().prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

// Run cleanup every hour
setInterval(cleanupExpired, CLEANUP_INTERVAL);

// Also run a quick in-memory cleanup every minute for magic links
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of magicLinks) {
    if (new Date(v.expiresAt).getTime() < now) magicLinks.delete(k);
  }
}, 60_000);
