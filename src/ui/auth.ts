import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

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

// ─── SQLite Setup ───

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "sessions.db");

function ensureDir(p: string) {
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

ensureDir(DB_PATH);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS magic_links (
    token TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Prepared statements
const insertMagicLink = db.prepare(
  `INSERT INTO magic_links (token, expires_at, used) VALUES (?, ?, 0)`
);
const getMagicLink = db.prepare(
  `SELECT token, expires_at as expiresAt, used FROM magic_links WHERE token = ?`
);
const deleteMagicLink = db.prepare(
  `DELETE FROM magic_links WHERE token = ?`
);
const markMagicLinkUsed = db.prepare(
  `UPDATE magic_links SET used = 1 WHERE token = ?`
);

const insertSession = db.prepare(
  `INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)`
);
const getSession = db.prepare(
  `SELECT id, created_at as createdAt, expires_at as expiresAt FROM sessions WHERE id = ?`
);
const deleteSession = db.prepare(
  `DELETE FROM sessions WHERE id = ?`
);
const deleteExpiredSessions = db.prepare(
  `DELETE FROM sessions WHERE expires_at < ?`
);
const deleteExpiredMagicLinks = db.prepare(
  `DELETE FROM magic_links WHERE expires_at < datetime(?, 'unixepoch')`
);

// ─── Public API ───

export function createMagicLink(): MagicLink {
  const token = ulid() + ulid();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL).toISOString();
  insertMagicLink.run(token, expiresAt);
  return { token, expiresAt, used: false };
}

export function consumeMagicLink(token: string): boolean {
  const link = getMagicLink.get(token) as any;
  if (!link) return false;
  if (link.used) return false;
  if (new Date(link.expiresAt).getTime() < Date.now()) {
    deleteMagicLink.run(token);
    return false;
  }
  // Mark used and delete in one go
  deleteMagicLink.run(token);
  return true;
}

export function createSession(): Session {
  const id = ulid();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL;
  insertSession.run(id, now, expiresAt);
  return { id, createdAt: now, expiresAt };
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const session = getSession.get(sessionId) as any;
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    deleteSession.run(sessionId);
    return false;
  }
  return true;
}

// Cleanup expired entries periodically
setInterval(() => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  deleteExpiredSessions.run(nowMs);
  deleteExpiredMagicLinks.run(nowSec);
}, 60_000);
