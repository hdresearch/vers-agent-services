/**
 * Backup Scheduler — automated backup on a configurable interval.
 *
 * Runs as a singleton timer that triggers BackupStore.createSnapshot()
 * every N hours, then prunes to retain only the latest M backups.
 * Emits events to the event log for observability.
 */

import { BackupStore } from "./store.js";
import { emit } from "../events/emit.js";

export class BackupScheduler {
  private store: BackupStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: Date | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;

  constructor(store: BackupStore) {
    this.store = store;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Start the scheduler */
  start(): void {
    if (this.timer) return; // already running

    const config = this.store.getConfig();
    const intervalMs = config.intervalHours * 60 * 60 * 1000;

    this.startedAt = new Date();
    this.updateNextScheduled(intervalMs);

    // Run immediately on start (first backup)
    this.tick();

    this.timer = setInterval(() => this.tick(), intervalMs);
    console.log(`[backup-scheduler] Started — interval: ${config.intervalHours}h, retain: ${config.retainCount}`);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.store.setNextScheduledAt(null);
    console.log("[backup-scheduler] Stopped");
  }

  /** Restart with updated config */
  restart(): void {
    this.stop();
    this.start();
  }

  /** Execute a single backup cycle */
  async tick(): Promise<void> {
    try {
      const meta = this.store.createSnapshot();
      this.consecutiveFailures = 0;
      this.lastError = null;

      // Prune old backups
      const pruned = this.store.pruneToRetainCount();

      emit("backup", "backup.snapshot.created", {
        backupId: meta.id,
        size: meta.size,
        fileCount: meta.fileCount,
        pruned: pruned.pruned,
        freedBytes: pruned.freed,
      });

      console.log(
        `[backup-scheduler] Snapshot ${meta.id} created (${formatBytes(meta.size)}, ${meta.fileCount} files)` +
        (pruned.pruned > 0 ? ` — pruned ${pruned.pruned} old backups` : "")
      );

      // Update next scheduled time
      const config = this.store.getConfig();
      this.updateNextScheduled(config.intervalHours * 60 * 60 * 1000);
    } catch (err) {
      this.consecutiveFailures++;
      this.lastError = (err as Error).message;

      emit("backup", "backup.snapshot.failed", {
        error: this.lastError,
        consecutiveFailures: this.consecutiveFailures,
      });

      console.error(`[backup-scheduler] Snapshot failed (${this.consecutiveFailures} consecutive):`, err);
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      startedAt: this.startedAt?.toISOString() || null,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private updateNextScheduled(intervalMs: number): void {
    const next = new Date(Date.now() + intervalMs);
    this.store.setNextScheduledAt(next);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
