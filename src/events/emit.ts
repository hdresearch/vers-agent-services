import { eventLogStore } from "./store.js";

/**
 * Emit an event to the durable event log.
 * This is the primary hook for all services to record mutations.
 *
 * Fire-and-forget: errors are logged but never thrown,
 * so emitting never breaks the calling service.
 */
export function emit(
  source: string,
  type: string,
  payload: unknown,
  agent?: string,
  metadata?: Record<string, unknown>,
): void {
  try {
    eventLogStore.append({ source, type, payload, agent, metadata });
  } catch (err) {
    console.error(`[event-log] Failed to emit ${type}:`, err);
  }
}
