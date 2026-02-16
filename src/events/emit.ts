import { eventLogStore } from "./store.js";
import { bus } from "../bus/eventbus.js";

/**
 * Emit an event to the durable event log AND the in-process event bus.
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

  // Also publish to the in-process event bus for reactive subscribers.
  // This is separate try/catch so a bus failure never affects the durable log.
  try {
    bus.publish({
      type,
      source,
      timestamp: new Date().toISOString(),
      data: payload,
      agent: agent,
    });
  } catch (err) {
    console.error(`[bus] Failed to publish ${type}:`, err);
  }
}
