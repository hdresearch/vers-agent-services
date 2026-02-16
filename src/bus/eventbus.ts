/**
 * In-process event bus with glob-style pattern matching.
 *
 * Patterns:
 *   'board.task.created'    — exact match
 *   'board.*'               — matches one segment (board.anything)
 *   'board.**'              — matches one or more segments (board.task.created, board.x.y.z)
 *   '*'                     — matches any single-segment type
 *   '**'                    — matches everything
 *
 * The bus is fire-and-forget: subscriber errors are caught and logged.
 */

export interface FleetEvent {
  type: string;       // 'board.task.created', 'feed.event.published', etc.
  source: string;     // service that emitted (board, feed, cryo, etc.)
  timestamp: string;  // ISO 8601
  data: unknown;      // payload
  agent?: string;     // optional originating agent
}

export type EventHandler = (event: FleetEvent) => void;

interface Subscription {
  pattern: string;
  regex: RegExp;
  handler: EventHandler;
}

/**
 * Convert a glob pattern to a regex.
 *
 *   '*'  → matches exactly one dot-delimited segment ([^.]+)
 *   '**' → matches one or more segments (.+)
 */
function patternToRegex(pattern: string): RegExp {
  const segments = pattern.split(".");
  const parts: string[] = [];

  for (const seg of segments) {
    if (seg === "**") {
      parts.push("GLOBSTAR");
    } else if (seg === "*") {
      parts.push("[^.]+");
    } else {
      parts.push(seg.replace(/[\\^$+?{}()|[\]]/g, "\\$&"));
    }
  }

  // Join literal/single-wildcard parts with \., then replace GLOBSTAR
  // GLOBSTAR should absorb surrounding dots since it matches across segments
  let regex = "^" + parts.join("\\.") + "$";

  // A GLOBSTAR surrounded by dots: \.GLOBSTAR\. → match dot-anything-dot
  // But GLOBSTAR itself can match dots, so: replace \.GLOBSTAR with (?:\..+)
  // and GLOBSTAR\. with (?:.+\.)
  // Simplest: GLOBSTAR = (?:[^.]+(?:\.[^.]+)*)  i.e. one or more segments
  regex = regex.replace(/GLOBSTAR/g, "(?:[^.]+(?:\\.[^.]+)*)");

  return new RegExp(regex);
}

// Ring buffer for replay
const DEFAULT_BUFFER_SIZE = 10_000;

class EventBus {
  private subscriptions = new Set<Subscription>();
  private buffer: FleetEvent[] = [];
  private bufferMax: number;

  constructor(bufferSize = DEFAULT_BUFFER_SIZE) {
    this.bufferMax = bufferSize;
  }

  /**
   * Subscribe to events matching a glob pattern.
   * Returns an unsubscribe function.
   */
  subscribe(pattern: string, handler: EventHandler): () => void {
    const sub: Subscription = {
      pattern,
      regex: patternToRegex(pattern),
      handler,
    };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  /**
   * Publish an event to all matching subscribers.
   * Also stores in ring buffer for replay.
   */
  publish(event: FleetEvent): void {
    // Buffer for replay
    this.buffer.push(event);
    if (this.buffer.length > this.bufferMax) {
      this.buffer = this.buffer.slice(-this.bufferMax);
    }

    // Dispatch to subscribers
    for (const sub of this.subscriptions) {
      if (sub.regex.test(event.type)) {
        try {
          sub.handler(event);
        } catch (err) {
          console.error(
            `[bus] subscriber error for pattern="${sub.pattern}" event="${event.type}":`,
            err,
          );
        }
      }
    }
  }

  /**
   * Replay buffered events since a given ISO timestamp.
   * Optionally filter by glob pattern.
   */
  replay(since: string, pattern?: string): FleetEvent[] {
    const sinceMs = new Date(since).getTime();
    let regex: RegExp | null = null;
    if (pattern) {
      regex = patternToRegex(pattern);
    }
    return this.buffer.filter((e) => {
      if (new Date(e.timestamp).getTime() <= sinceMs) return false;
      if (regex && !regex.test(e.type)) return false;
      return true;
    });
  }

  /**
   * Get subscriber count (for diagnostics).
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get buffer size (for diagnostics).
   */
  get bufferedEventCount(): number {
    return this.buffer.length;
  }

  /**
   * Clear all subscriptions and buffer. Mostly for tests.
   */
  reset(): void {
    this.subscriptions.clear();
    this.buffer = [];
  }
}

/** Singleton bus instance for the process */
export const bus = new EventBus();

/** Exported for tests that need a fresh bus */
export { EventBus, patternToRegex };
