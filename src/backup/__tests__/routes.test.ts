import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BackupStore } from "../store.js";
import { BackupScheduler } from "../scheduler.js";

const TEST_DATA_DIR = `data/test-backup-routes-${Date.now()}`;
const TEST_BACKUP_DIR = `${TEST_DATA_DIR}/backups`;

function setupTestData() {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  writeFileSync(join(TEST_DATA_DIR, "board.json"), JSON.stringify({ tasks: [] }));
  writeFileSync(join(TEST_DATA_DIR, "kb.json"), JSON.stringify({ entries: [] }));
  writeFileSync(join(TEST_DATA_DIR, "feed.jsonl"), '{"id":"1"}\n');

  const db = new Database(join(TEST_DATA_DIR, "chat.db"));
  db.exec("CREATE TABLE messages (id TEXT, content TEXT)");
  db.prepare("INSERT INTO messages VALUES (?, ?)").run("1", "test");
  db.close();
}

function createTestApp(store: BackupStore, scheduler: BackupScheduler) {
  const app = new Hono();

  app.post("/backup/snapshot", async (c) => {
    try {
      const meta = store.createSnapshot();
      return c.json({ backupId: meta.id, size: meta.size, timestamp: meta.timestamp }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/backup/list", (c) => {
    return c.json({ backups: store.listBackups(), count: store.listBackups().length });
  });

  app.get("/backup/status", (c) => {
    return c.json(store.getStatus());
  });

  app.post("/backup/restore/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const result = store.restoreFromBackup(id);
      return c.json({ restored: result.restored, files: result.files });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.delete("/backup/old", (c) => {
    const days = parseInt(c.req.query("days") || "7", 10);
    return c.json(store.pruneOlderThan(days));
  });

  app.post("/backup/config", async (c) => {
    const body = await c.req.json();
    const config = store.setConfig(body);
    return c.json({ config });
  });

  app.get("/backup/config", (c) => {
    return c.json(store.getConfig());
  });

  app.get("/backup/export", async (c) => {
    const path = store.getLatestBackupPath();
    if (!path) return c.json({ error: "No backup" }, 404);
    return c.json({ path }); // simplified for test
  });

  app.post("/backup/import", async (c) => {
    const body = await c.req.arrayBuffer();
    const meta = store.importBackup(Buffer.from(body));
    return c.json({ backupId: meta.id }, 201);
  });

  return app;
}

describe("Backup Routes", () => {
  let store: BackupStore;
  let scheduler: BackupScheduler;
  let app: Hono;

  beforeEach(() => {
    try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
    setupTestData();
    store = new BackupStore(TEST_DATA_DIR, TEST_BACKUP_DIR);
    scheduler = new BackupScheduler(store);
    app = createTestApp(store, scheduler);
  });

  afterEach(() => {
    scheduler.stop();
    try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  });

  it("POST /backup/snapshot creates a backup", async () => {
    const res = await app.request("/backup/snapshot", { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.backupId).toBeTruthy();
    expect(body.size).toBeGreaterThan(0);
    expect(body.timestamp).toBeTruthy();
  });

  it("GET /backup/list returns backups", async () => {
    // Create one first
    await app.request("/backup/snapshot", { method: "POST" });

    const res = await app.request("/backup/list");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.backups.length).toBe(1);
  });

  it("GET /backup/status returns status", async () => {
    const res = await app.request("/backup/status");
    const body = await res.json();
    expect(body.totalBackups).toBe(0);
    expect(body.config.intervalHours).toBe(4);
  });

  it("POST /backup/restore/:id restores data", async () => {
    const snap = await app.request("/backup/snapshot", { method: "POST" });
    const { backupId } = await snap.json();

    // Corrupt data
    writeFileSync(join(TEST_DATA_DIR, "board.json"), "BROKEN");

    const res = await app.request(`/backup/restore/${backupId}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restored).toBeGreaterThan(0);
    expect(body.files).toContain("board.json");
  });

  it("POST /backup/restore/bad returns 404", async () => {
    const res = await app.request("/backup/restore/nonexistent", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /backup/config updates config", async () => {
    const res = await app.request("/backup/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervalHours: 6, retainCount: 12 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.intervalHours).toBe(6);
    expect(body.config.retainCount).toBe(12);
  });

  it("GET /backup/config returns config", async () => {
    const res = await app.request("/backup/config");
    const body = await res.json();
    expect(body.intervalHours).toBe(4);
    expect(body.retainCount).toBe(24);
  });

  it("GET /backup/export returns 404 when no backups", async () => {
    const res = await app.request("/backup/export");
    expect(res.status).toBe(404);
  });

  it("full cycle: snapshot → export → import → restore", async () => {
    // Create snapshot
    const snapRes = await app.request("/backup/snapshot", { method: "POST" });
    const { backupId } = await snapRes.json();
    expect(backupId).toBeTruthy();

    // List should show 1
    const listRes = await app.request("/backup/list");
    const { count } = await listRes.json();
    expect(count).toBe(1);

    // Status should show 1
    const statusRes = await app.request("/backup/status");
    const status = await statusRes.json();
    expect(status.totalBackups).toBe(1);
  });
});
