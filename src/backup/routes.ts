/**
 * Backup Routes — REST API for backup/restore/export/import.
 */

import { Hono } from "hono";
import { readFileSync, statSync } from "node:fs";
import { BackupStore } from "./store.js";
import { BackupScheduler } from "./scheduler.js";
import { emit } from "../events/emit.js";

export const backupStore = new BackupStore();
export const backupScheduler = new BackupScheduler(backupStore);

export const backupRoutes = new Hono();

// --- Snapshot ---

// POST /backup/snapshot — Create a full backup NOW
backupRoutes.post("/snapshot", async (c) => {
  try {
    const meta = backupStore.createSnapshot();
    emit("backup", "backup.manual_snapshot", { backupId: meta.id, size: meta.size });
    return c.json({
      backupId: meta.id,
      size: formatBytes(meta.size),
      sizeBytes: meta.size,
      fileCount: meta.fileCount,
      timestamp: meta.timestamp,
    }, 201);
  } catch (err) {
    return c.json({ error: "Backup failed", detail: (err as Error).message }, 500);
  }
});

// --- List ---

// GET /backup/list — List available backups
backupRoutes.get("/list", (c) => {
  const backups = backupStore.listBackups();
  return c.json({
    backups: backups.map(b => ({
      ...b,
      sizeFormatted: formatBytes(b.size),
    })),
    count: backups.length,
  });
});

// --- Status ---

// GET /backup/status — Last backup, next scheduled, totals
backupRoutes.get("/status", (c) => {
  const status = backupStore.getStatus();
  const schedulerStatus = backupScheduler.getStatus();
  return c.json({
    ...status,
    totalSizeFormatted: formatBytes(status.totalSizeBytes),
    scheduler: schedulerStatus,
  });
});

// --- Restore ---

// POST /backup/restore/:id — Restore from a specific backup
backupRoutes.post("/restore/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const result = backupStore.restoreFromBackup(id);
    emit("backup", "backup.restored", { backupId: id, restored: result.restored });
    return c.json({
      message: "Restore completed — restart agent-services to reload data",
      backupId: id,
      restored: result.restored,
      files: result.files,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("not found")) {
      return c.json({ error: msg }, 404);
    }
    return c.json({ error: "Restore failed", detail: msg }, 500);
  }
});

// --- Prune ---

// DELETE /backup/old — Prune backups older than N days
backupRoutes.delete("/old", async (c) => {
  const daysStr = c.req.query("days");
  const days = daysStr ? parseInt(daysStr, 10) : 7;
  if (isNaN(days) || days < 1) {
    return c.json({ error: "days must be a positive integer" }, 400);
  }

  const result = backupStore.pruneOlderThan(days);
  return c.json({
    pruned: result.pruned,
    freedBytes: result.freed,
    freedFormatted: formatBytes(result.freed),
  });
});

// --- Config ---

// POST /backup/config — Update scheduler config
backupRoutes.post("/config", async (c) => {
  try {
    const body = await c.req.json();
    const config = backupStore.setConfig(body);

    // Restart scheduler if running to pick up new config
    if (backupScheduler.isRunning) {
      backupScheduler.restart();
    }

    return c.json({ config, message: "Config updated" });
  } catch (err) {
    return c.json({ error: "Invalid config", detail: (err as Error).message }, 400);
  }
});

// GET /backup/config — Get current config
backupRoutes.get("/config", (c) => {
  return c.json(backupStore.getConfig());
});

// --- Export / Import (disaster recovery) ---

// GET /backup/export — Download latest backup tarball
backupRoutes.get("/export", async (c) => {
  const idParam = c.req.query("id");
  let backupPath: string | null;

  if (idParam) {
    backupPath = backupStore.getBackupPath(idParam);
  } else {
    backupPath = backupStore.getLatestBackupPath();
  }

  if (!backupPath) {
    return c.json({ error: "No backup available for export" }, 404);
  }

  const stat = statSync(backupPath);
  const data = readFileSync(backupPath);
  const filename = backupPath.split("/").pop() || "backup.tar.gz";

  return new Response(data, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(stat.size),
    },
  });
});

// POST /backup/import — Upload and register a backup tarball
backupRoutes.post("/import", async (c) => {
  try {
    const body = await c.req.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return c.json({ error: "No data received" }, 400);
    }

    const buffer = Buffer.from(body);
    const meta = backupStore.importBackup(buffer);
    emit("backup", "backup.imported", { backupId: meta.id, size: meta.size });

    return c.json({
      message: "Backup imported successfully — use POST /backup/restore/:id to restore",
      backupId: meta.id,
      size: formatBytes(meta.size),
      sizeBytes: meta.size,
    }, 201);
  } catch (err) {
    return c.json({ error: "Import failed", detail: (err as Error).message }, 500);
  }
});

// --- Scheduler control ---

// POST /backup/scheduler/start — Start automated backups
backupRoutes.post("/scheduler/start", (c) => {
  if (backupScheduler.isRunning) {
    return c.json({ message: "Scheduler already running", ...backupScheduler.getStatus() });
  }
  backupScheduler.start();
  return c.json({ message: "Scheduler started", ...backupScheduler.getStatus() });
});

// POST /backup/scheduler/stop — Stop automated backups
backupRoutes.post("/scheduler/stop", (c) => {
  backupScheduler.stop();
  return c.json({ message: "Scheduler stopped" });
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
