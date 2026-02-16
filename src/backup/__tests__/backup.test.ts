import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BackupStore } from "../store.js";
import { BackupScheduler } from "../scheduler.js";

const TEST_DATA_DIR = `data/test-backup-data-${Date.now()}`;
const TEST_BACKUP_DIR = `${TEST_DATA_DIR}/backups`;

function setupTestData() {
  mkdirSync(TEST_DATA_DIR, { recursive: true });

  // Create test JSON files
  writeFileSync(join(TEST_DATA_DIR, "board.json"), JSON.stringify({ tasks: [{ id: "1", title: "Test task" }] }));
  writeFileSync(join(TEST_DATA_DIR, "kb.json"), JSON.stringify({ entries: [{ id: "1", title: "Test entry" }] }));
  writeFileSync(join(TEST_DATA_DIR, "reports.json"), JSON.stringify({ reports: [] }));
  writeFileSync(join(TEST_DATA_DIR, "skills.json"), JSON.stringify({ skills: [] }));

  // Create test JSONL file
  writeFileSync(join(TEST_DATA_DIR, "feed.jsonl"), '{"id":"1","msg":"hello"}\n{"id":"2","msg":"world"}\n');
  writeFileSync(join(TEST_DATA_DIR, "log.jsonl"), '{"id":"1","line":"test"}\n');

  // Create test SQLite DB
  const db = new Database(join(TEST_DATA_DIR, "chat.db"));
  db.exec("CREATE TABLE messages (id TEXT, content TEXT)");
  db.prepare("INSERT INTO messages VALUES (?, ?)").run("msg1", "Hello backup");
  db.close();
}

function cleanup() {
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
}

describe("BackupStore", () => {
  let store: BackupStore;

  beforeEach(() => {
    cleanup();
    setupTestData();
    store = new BackupStore(TEST_DATA_DIR, TEST_BACKUP_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a snapshot with all data files", () => {
    const meta = store.createSnapshot();

    expect(meta.id).toBeTruthy();
    expect(meta.timestamp).toBeTruthy();
    expect(meta.size).toBeGreaterThan(0);
    expect(meta.fileCount).toBeGreaterThanOrEqual(6); // 4 json + 1 jsonl + 1 db
    expect(meta.filename).toMatch(/^backup-.+\.tar\.gz$/);

    // Tarball should exist
    const backupPath = store.getBackupPath(meta.id);
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
  });

  it("lists backups newest first", () => {
    const snap1 = store.createSnapshot();

    // Small delay so timestamps differ
    const snap2 = store.createSnapshot();

    const list = store.listBackups();
    expect(list.length).toBe(2);
    // Newest first (by filename sort which is ULID-based)
    expect(list[0].id).toBe(snap2.id);
    expect(list[1].id).toBe(snap1.id);
  });

  it("restores from a backup", () => {
    const meta = store.createSnapshot();

    // Corrupt the data
    writeFileSync(join(TEST_DATA_DIR, "board.json"), "CORRUPTED");
    writeFileSync(join(TEST_DATA_DIR, "kb.json"), "ALSO CORRUPTED");

    // Restore
    const result = store.restoreFromBackup(meta.id);
    expect(result.restored).toBeGreaterThanOrEqual(6);
    expect(result.files).toContain("board.json");
    expect(result.files).toContain("kb.json");

    // Verify data is restored
    const boardData = JSON.parse(readFileSync(join(TEST_DATA_DIR, "board.json"), "utf-8"));
    expect(boardData.tasks[0].title).toBe("Test task");

    const kbData = JSON.parse(readFileSync(join(TEST_DATA_DIR, "kb.json"), "utf-8"));
    expect(kbData.entries[0].title).toBe("Test entry");
  });

  it("restores SQLite databases correctly", () => {
    const meta = store.createSnapshot();

    // Delete the DB
    rmSync(join(TEST_DATA_DIR, "chat.db"), { force: true });
    expect(existsSync(join(TEST_DATA_DIR, "chat.db"))).toBe(false);

    // Restore
    store.restoreFromBackup(meta.id);

    // Verify DB is restored and readable
    const db = new Database(join(TEST_DATA_DIR, "chat.db"), { readonly: true });
    const rows = db.prepare("SELECT * FROM messages").all() as any[];
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("Hello backup");
  });

  it("throws when restoring a nonexistent backup", () => {
    expect(() => store.restoreFromBackup("nonexistent")).toThrow("Backup not found");
  });

  it("prunes old backups", () => {
    store.createSnapshot();
    store.createSnapshot();

    // Prune to retain count
    store.setConfig({ retainCount: 1 });
    store.createSnapshot();
    store.createSnapshot();
    store.createSnapshot();
    const pruneResult = store.pruneToRetainCount();
    expect(pruneResult.pruned).toBeGreaterThan(0);
    expect(store.listBackups().length).toBe(1);
  });

  it("returns status correctly", () => {
    const status = store.getStatus();
    expect(status.totalBackups).toBe(0);
    expect(status.lastBackup).toBeNull();

    store.createSnapshot();
    const status2 = store.getStatus();
    expect(status2.totalBackups).toBe(1);
    expect(status2.lastBackup).toBeTruthy();
    expect(status2.config.intervalHours).toBe(4);
    expect(status2.config.retainCount).toBe(24);
  });

  it("imports a backup tarball", () => {
    // Create a backup and read its tarball
    const meta = store.createSnapshot();
    const backupPath = store.getBackupPath(meta.id)!;
    const data = readFileSync(backupPath);

    // Import it as a new backup
    const imported = store.importBackup(data, "backup-imported.tar.gz");
    expect(imported.id).toBeTruthy();
    expect(imported.size).toBe(data.length);

    // Should now appear in list
    const list = store.listBackups();
    expect(list.length).toBe(2);
  });

  it("getLatestBackupPath returns newest", () => {
    expect(store.getLatestBackupPath()).toBeNull();

    store.createSnapshot();
    const snap2 = store.createSnapshot();

    const path = store.getLatestBackupPath();
    expect(path).toBeTruthy();
    expect(path).toContain(snap2.id);
  });

  it("updates config", () => {
    store.setConfig({ intervalHours: 6, retainCount: 12 });
    const cfg = store.getConfig();
    expect(cfg.intervalHours).toBe(6);
    expect(cfg.retainCount).toBe(12);
  });
});

describe("BackupScheduler", () => {
  let store: BackupStore;
  let scheduler: BackupScheduler;

  beforeEach(() => {
    cleanup();
    setupTestData();
    store = new BackupStore(TEST_DATA_DIR, TEST_BACKUP_DIR);
    // Use very short interval for testing
    store.setConfig({ intervalHours: 1, retainCount: 5 });
    scheduler = new BackupScheduler(store);
  });

  afterEach(() => {
    scheduler.stop();
    cleanup();
  });

  it("starts and stops", () => {
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);

    // Should have created a backup on start
    const backups = store.listBackups();
    expect(backups.length).toBeGreaterThanOrEqual(1);

    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("tick creates a backup", async () => {
    await scheduler.tick();
    const backups = store.listBackups();
    expect(backups.length).toBe(1);
  });

  it("reports status", () => {
    const status = scheduler.getStatus();
    expect(status.running).toBe(false);
    expect(status.consecutiveFailures).toBe(0);

    scheduler.start();
    const status2 = scheduler.getStatus();
    expect(status2.running).toBe(true);
    expect(status2.startedAt).toBeTruthy();
  });

  it("does not start twice", () => {
    scheduler.start();
    const initialBackups = store.listBackups().length;
    scheduler.start(); // should no-op
    expect(store.listBackups().length).toBe(initialBackups);
  });
});
