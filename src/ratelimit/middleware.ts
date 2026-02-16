/**
 * Enhanced rate limiting middleware for fleet-scale load.
 *
 * Builds on the existing sliding-window rate limiter with:
 *   - Global rate limit (all endpoints)
 *   - Per-route burst limits
 *   - Priority detection (UI vs agent vs bulk)
 *   - Connection: close for agent responses (prevent socket exhaustion)
 */

import type { MiddlewareHandler, Context } from "hono";
import { Priority } from "./queue.js";

// ---- Global rate limit config ----

interface GlobalRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_GLOBAL: GlobalRateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 200,  // 200 req/min per token — generous but bounded
};

interface Bucket {
  timestamps: number[];
}

const globalBuckets = new Map<string, Bucket>();

// Periodic cleanup
const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of globalBuckets) {
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < DEFAULT_GLOBAL.windowMs);
    if (bucket.timestamps.length === 0) globalBuckets.delete(key);
  }
}, 60_000);
if (_cleanup.unref) _cleanup.unref();

/**
 * Global rate limiter — applies to ALL authenticated API requests.
 * Per-token bucket with generous limits to catch runaway agents.
 */
export function globalRateLimit(opts: Partial<GlobalRateLimitConfig> = {}): MiddlewareHandler {
  const config = { ...DEFAULT_GLOBAL, ...opts };

  return async (c, next) => {
    const now = Date.now();
    const key = extractKey(c);

    let bucket = globalBuckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      globalBuckets.set(key, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < config.windowMs);

    if (bucket.timestamps.length >= config.maxRequests) {
      const oldest = bucket.timestamps[0];
      const retryAfterMs = config.windowMs - (now - oldest);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      return c.json(
        { error: "Too Many Requests", retryAfter: retryAfterSec },
        429,
        {
          "Retry-After": String(retryAfterSec),
          "X-RateLimit-Limit": String(config.maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil((oldest + config.windowMs) / 1000)),
          "Connection": "close",
        },
      );
    }

    bucket.timestamps.push(now);

    const remaining = config.maxRequests - bucket.timestamps.length;
    c.header("X-RateLimit-Limit", String(config.maxRequests));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset",
      String(Math.ceil((bucket.timestamps[0] + config.windowMs) / 1000)));

    return next();
  };
}

/**
 * Detect request priority from context.
 *
 * UI requests (via session cookie or /ui/api proxy) → HIGH
 * Bulk endpoints (feed batch, log batch) → LOW
 * Everything else → NORMAL
 */
export function detectPriority(c: Context): Priority {
  const path = c.req.path;
  const cookie = c.req.header("cookie");

  // UI requests — identified by session cookie or /ui/ prefix origin
  if (cookie?.includes("vers-session") || c.req.header("x-ui-request") === "1") {
    return Priority.HIGH;
  }

  // Bulk endpoints
  if (
    (path.includes("/feed/events") && c.req.method === "POST") ||
    (path.includes("/log") && c.req.method === "POST")
  ) {
    return Priority.LOW;
  }

  return Priority.NORMAL;
}

/**
 * Middleware that closes connections for agent API requests.
 * Prevents 30 agents from holding persistent connections that exhaust sockets.
 * UI requests keep their connections alive for responsiveness.
 */
export function connectionManager(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // Don't close connections for UI (session-based) or SSE streams
    const cookie = c.req.header("cookie");
    const isSSE = c.res.headers.get("content-type")?.includes("text/event-stream");

    if (!cookie?.includes("vers-session") && !isSSE) {
      c.res.headers.set("Connection", "close");
    }
  };
}

/**
 * Rate limit status endpoint handler.
 */
export function getRateLimitStatus() {
  const status: Record<string, any> = {};
  for (const [key, bucket] of globalBuckets) {
    const now = Date.now();
    const active = bucket.timestamps.filter((ts) => now - ts < DEFAULT_GLOBAL.windowMs);
    status[key] = {
      requestsInWindow: active.length,
      limit: DEFAULT_GLOBAL.maxRequests,
      remaining: Math.max(0, DEFAULT_GLOBAL.maxRequests - active.length),
    };
  }
  return status;
}

// ---- Helpers ----

function extractKey(c: Context): string {
  const auth = c.req.header("authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return `bearer:${match[1].slice(0, 16)}...`;
  }
  // Fall back to cookie session
  const cookie = c.req.header("cookie");
  if (cookie?.includes("vers-session")) return "ui-session";
  return "__anonymous__";
}
