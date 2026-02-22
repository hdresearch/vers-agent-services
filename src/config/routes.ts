import { Hono } from "hono";
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const configRoutes = new Hono();

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "config.db");

function ensureDir(p: string) {
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

ensureDir(DB_PATH);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    label TEXT,
    secret INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const getAll = db.prepare(`SELECT key, value, label, secret, updated_at as updatedAt FROM config ORDER BY key`);
const getOne = db.prepare(`SELECT key, value, label, secret, updated_at as updatedAt FROM config WHERE key = ?`);
const upsert = db.prepare(`INSERT INTO config (key, value, label, secret, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, label=excluded.label, secret=excluded.secret, updated_at=datetime('now')`);
const deleteOne = db.prepare(`DELETE FROM config WHERE key = ?`);

// GET /config — list all config entries
configRoutes.get("/", (c) => {
  const items = getAll.all() as any[];
  return c.json({ items });
});

// GET /config/:key — get a single value
configRoutes.get("/:key", (c) => {
  const item = getOne.get(c.req.param("key"));
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

// PUT /config/:key — set a value
configRoutes.put("/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  const value = body.value;
  const label = body.label || null;
  const secret = body.secret ? 1 : 0;
  if (value === undefined) return c.json({ error: "value required" }, 400);
  upsert.run(key, value, label, secret);
  return c.json({ ok: true, key });
});

// DELETE /config/:key
configRoutes.delete("/:key", (c) => {
  deleteOne.run(c.req.param("key"));
  return c.json({ ok: true });
});
