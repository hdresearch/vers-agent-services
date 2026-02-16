/**
 * Priority lanes for the write queue.
 *
 * Re-exports Priority enum and provides helpers for route-level priority assignment.
 * The actual priority detection logic lives in middleware.ts (detectPriority).
 * The queue implementation lives in queue.ts.
 *
 * This module provides convenience wrappers for common patterns:
 *   - Wrapping a store method to go through the write queue
 *   - Tagging a request with its priority via middleware
 */

import type { MiddlewareHandler } from "hono";
import { Priority, writeQueue } from "./queue.js";
import { detectPriority } from "./middleware.js";

export { Priority } from "./queue.js";

/**
 * Middleware that tags the request context with its detected priority.
 * Downstream handlers can read c.get("writePriority") to pass to writeQueue.enqueue().
 */
export function tagPriority(): MiddlewareHandler {
  return async (c, next) => {
    c.set("writePriority", detectPriority(c));
    return next();
  };
}

/**
 * Helper: wrap a synchronous better-sqlite3 write call through the queue.
 * better-sqlite3 is synchronous, but we wrap it in a promise for the queue.
 */
export function queuedWrite<T>(fn: () => T, priority: Priority = Priority.NORMAL): Promise<T> {
  return writeQueue.enqueue(() => fn(), priority);
}

/**
 * Helper: wrap a store's write method to always go through the queue.
 * Usage:
 *   store.create = wrapStoreWrite(store.create.bind(store));
 */
export function wrapStoreWrite<Args extends any[], R>(
  method: (...args: Args) => R,
  priority: Priority = Priority.NORMAL,
): (...args: Args) => Promise<R> {
  return (...args: Args) => writeQueue.enqueue(() => method(...args), priority);
}
