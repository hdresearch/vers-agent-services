/**
 * WriteQueue — Serializes all SQLite write operations to prevent SQLITE_BUSY.
 *
 * SQLite can handle concurrent reads (WAL mode), but concurrent writes cause
 * lock contention. When 30 agents hit the server simultaneously, writes pile up
 * and timeouts cascade. This queue ensures writes execute one at a time.
 *
 * Priority lanes:
 *   HIGH   — UI requests (dashboard must never feel sluggish)
 *   NORMAL — Agent API writes (standard CRUD)
 *   LOW    — Bulk operations (feed batch, log dumps)
 */

export enum Priority {
  HIGH = 0,
  NORMAL = 1,
  LOW = 2,
}

interface QueueEntry<T = any> {
  fn: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  priority: Priority;
  enqueued: number;
}

export interface WriteQueueStats {
  depth: number;
  depthByPriority: { high: number; normal: number; low: number };
  processing: boolean;
  totalProcessed: number;
  totalTimedOut: number;
  avgLatencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class WriteQueue {
  private queues: [QueueEntry[], QueueEntry[], QueueEntry[]] = [[], [], []];
  private processing = false;
  private totalProcessed = 0;
  private totalTimedOut = 0;
  private latencySum = 0;
  private timeoutMs: number;

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Enqueue a write operation. Returns a promise that resolves when the
   * operation completes (or rejects on error/timeout).
   */
  async enqueue<T>(fn: () => Promise<T> | T, priority: Priority = Priority.NORMAL): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({
        fn,
        resolve,
        reject,
        priority,
        enqueued: Date.now(),
      });
      this.drain();
    });
  }

  /** Process queued entries one at a time, highest priority first. */
  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        const entry = this.dequeue();
        if (!entry) break;

        const waited = Date.now() - entry.enqueued;

        // If it already waited too long in the queue, reject immediately
        if (waited > this.timeoutMs) {
          this.totalTimedOut++;
          entry.reject(new WriteQueueTimeoutError(waited));
          continue;
        }

        // Execute with remaining timeout budget
        const remaining = this.timeoutMs - waited;
        try {
          const result = await Promise.race([
            Promise.resolve(entry.fn()),
            timeout(remaining),
          ]);
          this.totalProcessed++;
          this.latencySum += Date.now() - entry.enqueued;
          entry.resolve(result);
        } catch (err) {
          if (err instanceof WriteQueueTimeoutError) {
            this.totalTimedOut++;
          }
          entry.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Pick the highest-priority entry. HIGH drains fully before NORMAL, etc. */
  private dequeue(): QueueEntry | undefined {
    for (const q of this.queues) {
      if (q.length > 0) return q.shift()!;
    }
    return undefined;
  }

  /** Current queue statistics. */
  get stats(): WriteQueueStats {
    const depth = this.queues[0].length + this.queues[1].length + this.queues[2].length;
    return {
      depth,
      depthByPriority: {
        high: this.queues[0].length,
        normal: this.queues[1].length,
        low: this.queues[2].length,
      },
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalTimedOut: this.totalTimedOut,
      avgLatencyMs: this.totalProcessed > 0
        ? Math.round(this.latencySum / this.totalProcessed)
        : 0,
    };
  }
}

export class WriteQueueTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`Write queue timeout after ${waitedMs}ms`);
    this.name = "WriteQueueTimeoutError";
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new WriteQueueTimeoutError(ms)), ms),
  );
}

// ---------------------------------------------------------------------------
// Singleton — shared across all SQLite stores
// ---------------------------------------------------------------------------

export const writeQueue = new WriteQueue();
