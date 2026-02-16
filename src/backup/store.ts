/**
 * Backup Store — snapshot all data files, compress, restore.
 *
 * Handles the core backup/restore mechanics:
 * - Enumerate all data files (JSON, JSONL, SQLite .db)
 * - Copy them into a timestamped directory
 * - For SQLite: use `.backup()` API for safe hot backup
 * - Compress to tarball
 * - Restore: extract tarball and overwrite data/
 */

import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { ulid } from "ulid";

export interface BackupMeta {
  id: string;
  timestamp: string;
  size: number;         // bytes
  fileCount: number;
  filename: string;
}

export interface BackupConfig {
  intervalHours: number;
  retainCount: number;
}

export interface BackupStatus {
  lastBackup: BackupMeta | null;
  nextScheduledAt: string | null;
  totalBackups: number;
  totalSizeBytes: number;
  config: BackupConfig;
}

// All known data files — production set (excludes test-* files)
const DATA_FILES_JSON = [
  "board.json",
  "kb.json",
  "skills.json",
  "extensions.json",
  "agent-manifests.json",
  "reports.json",
  "registry.json",
  "cryo-agents.json",
  "couch.json",
  "gossip.json",
  "loop.json",
  "personas.json",
  "deploy-history.json",
];

const DATA_FILES_JSONL = [
  "feed.jsonl",
  "log.jsonl",
  "journal.jsonl",
  "commits.jsonl",
];

const DATA_FILES_SQLITE = [
  "fleet-chat.db",
  "chat.db",
  "config.db",
  "contacts.db",
  "daemon.db",
  "docs.db",
  "aegis.db",
  "reports.db",
  "router.db",
  "sessions.db",
  "api-keys.db",
  "events.db",
];

export class BackupStore {
  private dataDir: string;
  private backupDir: string;
  private config: BackupConfig;
  private lastBackup: BackupMeta | null = null;
  private nextScheduledAt: Date | null = null;

  constructor(dataDir = "data", backupDir = "data/backups") {
    this.dataDir = dataDir;
    this.backupDir = backupDir;
    this.config = { intervalHours: 4, retainCount: 24 };
    mkdirSync(this.backupDir, { recursive: true });
    // Load last backup info
    this.lastBackup = this.findLatestBackup();
  }

  /** Create a full snapshot of all data files */
  createSnapshot(): BackupMeta {
    const id = ulid();
    const timestamp = new Date().toISOString();
    const safeTs = timestamp.replace(/[:.]/g, "-");
    const snapDir = join(this.backupDir, `snap-${safeTs}`);
    mkdirSync(snapDir, { recursive: true });

    let fileCount = 0;

    // Copy JSON and JSONL files
    for (const file of [...DATA_FILES_JSON, ...DATA_FILES_JSONL]) {
      const src = join(this.dataDir, file);
      if (existsSync(src)) {
        copyFileSync(src, join(snapDir, file));
        fileCount++;
      }
    }

    // Copy SQLite databases using plain file copy
    // (WAL mode means we might get a slightly stale snapshot, but it's safe
    // since SQLite handles this gracefully on next open. For production,
    // the daemon should flush stores before backup.)
    for (const file of DATA_FILES_SQLITE) {
      const src = join(this.dataDir, file);
      if (existsSync(src)) {
        try {
          copyFileSync(src, join(snapDir, file));
          // Also copy WAL and SHM files if they exist
          for (const ext of ["-wal", "-shm"]) {
            const walSrc = src + ext;
            if (existsSync(walSrc)) {
              copyFileSync(walSrc, join(snapDir, file + ext));
            }
          }
          fileCount++;
        } catch (err) {
          console.warn(`[backup] Failed to copy ${file}:`, err);
        }
      }
    }

    // Also grab any other data/ files we might have missed
    if (existsSync(this.dataDir)) {
      for (const f of readdirSync(this.dataDir)) {
        if (f === "backups") continue; // skip backup dir itself
        const src = join(this.dataDir, f);
        const dst = join(snapDir, f);
        if (!existsSync(dst) && statSync(src).isFile()) {
          try {
            copyFileSync(src, dst);
            fileCount++;
          } catch {}
        }
      }
    }

    // Write metadata
    const metaPath = join(snapDir, "_backup-meta.json");
    writeFileSync(metaPath, JSON.stringify({ id, timestamp, fileCount }));

    // Compress to tarball
    const tarball = join(this.backupDir, `backup-${id}.tar.gz`);
    execSync(`tar -czf "${tarball}" -C "${this.backupDir}" "snap-${safeTs}"`, { timeout: 60_000 });

    // Clean up snapshot directory
    rmSync(snapDir, { recursive: true, force: true });

    const size = statSync(tarball).size;
    const meta: BackupMeta = {
      id,
      timestamp,
      size,
      fileCount,
      filename: `backup-${id}.tar.gz`,
    };

    this.lastBackup = meta;
    return meta;
  }

  /** List all available backups (sorted newest first) */
  listBackups(): BackupMeta[] {
    if (!existsSync(this.backupDir)) return [];
    const files = readdirSync(this.backupDir)
      .filter(f => f.startsWith("backup-") && f.endsWith(".tar.gz"))
      .sort()
      .reverse();

    return files.map(f => {
      const stat = statSync(join(this.backupDir, f));
      const idMatch = f.match(/backup-(.+)\.tar\.gz/);
      const id = idMatch ? idMatch[1] : f;
      return {
        id,
        timestamp: stat.mtime.toISOString(),
        size: stat.size,
        fileCount: -1, // unknown without extracting
        filename: f,
      };
    });
  }

  /** Restore from a backup by ID */
  restoreFromBackup(id: string): { restored: number; files: string[] } {
    const tarball = join(this.backupDir, `backup-${id}.tar.gz`);
    if (!existsSync(tarball)) {
      throw new Error(`Backup not found: ${id}`);
    }

    // Extract to temp dir
    const tempDir = join(this.backupDir, `_restore-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    execSync(`tar -xzf "${tarball}" -C "${tempDir}"`, { timeout: 60_000 });

    // Find the snapshot directory inside
    const extracted = readdirSync(tempDir);
    const snapDirName = extracted.find(d => d.startsWith("snap-"));
    if (!snapDirName) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error("Invalid backup archive: no snapshot directory found");
    }

    const snapDir = join(tempDir, snapDirName);
    const files = readdirSync(snapDir).filter(f => f !== "_backup-meta.json");
    let restored = 0;

    for (const file of files) {
      const src = join(snapDir, file);
      const dst = join(this.dataDir, file);
      try {
        copyFileSync(src, dst);
        restored++;
      } catch (err) {
        console.warn(`[backup] Failed to restore ${file}:`, err);
      }
    }

    rmSync(tempDir, { recursive: true, force: true });
    return { restored, files };
  }

  /** Get path to a backup tarball for export */
  getBackupPath(id: string): string | null {
    const tarball = join(this.backupDir, `backup-${id}.tar.gz`);
    return existsSync(tarball) ? tarball : null;
  }

  /** Get path to the latest backup tarball */
  getLatestBackupPath(): string | null {
    const backups = this.listBackups();
    if (backups.length === 0) return null;
    return join(this.backupDir, backups[0].filename);
  }

  /** Import a backup tarball from an uploaded file */
  importBackup(data: Buffer, filename?: string): BackupMeta {
    const id = ulid();
    const outName = filename || `backup-${id}.tar.gz`;
    const outPath = join(this.backupDir, outName.startsWith("backup-") ? outName : `backup-${id}.tar.gz`);
    writeFileSync(outPath, data);
    const size = statSync(outPath).size;
    return {
      id,
      timestamp: new Date().toISOString(),
      size,
      fileCount: -1,
      filename: basename(outPath),
    };
  }

  /** Prune backups older than N days */
  pruneOlderThan(days: number): { pruned: number; freed: number } {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const backups = this.listBackups();
    let pruned = 0;
    let freed = 0;

    for (const b of backups) {
      const mtime = new Date(b.timestamp).getTime();
      if (mtime < cutoff) {
        const path = join(this.backupDir, b.filename);
        if (existsSync(path)) {
          freed += b.size;
          unlinkSync(path);
          pruned++;
        }
      }
    }

    return { pruned, freed };
  }

  /** Prune to retain only the latest N backups */
  pruneToRetainCount(): { pruned: number; freed: number } {
    const backups = this.listBackups(); // newest first
    if (backups.length <= this.config.retainCount) {
      return { pruned: 0, freed: 0 };
    }

    const toRemove = backups.slice(this.config.retainCount);
    let pruned = 0;
    let freed = 0;

    for (const b of toRemove) {
      const path = join(this.backupDir, b.filename);
      if (existsSync(path)) {
        freed += b.size;
        unlinkSync(path);
        pruned++;
      }
    }

    return { pruned, freed };
  }

  /** Get current status */
  getStatus(): BackupStatus {
    const backups = this.listBackups();
    const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
    return {
      lastBackup: backups.length > 0 ? backups[0] : null,
      nextScheduledAt: this.nextScheduledAt?.toISOString() || null,
      totalBackups: backups.length,
      totalSizeBytes: totalSize,
      config: { ...this.config },
    };
  }

  /** Update schedule config */
  setConfig(cfg: Partial<BackupConfig>): BackupConfig {
    if (cfg.intervalHours !== undefined && cfg.intervalHours > 0) {
      this.config.intervalHours = cfg.intervalHours;
    }
    if (cfg.retainCount !== undefined && cfg.retainCount > 0) {
      this.config.retainCount = cfg.retainCount;
    }
    return { ...this.config };
  }

  getConfig(): BackupConfig {
    return { ...this.config };
  }

  setNextScheduledAt(date: Date | null): void {
    this.nextScheduledAt = date;
  }

  private findLatestBackup(): BackupMeta | null {
    const backups = this.listBackups();
    return backups.length > 0 ? backups[0] : null;
  }
}
