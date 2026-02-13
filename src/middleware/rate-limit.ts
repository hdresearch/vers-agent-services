import type { MiddlewareHandler } from "hono";

interface RateLimitOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum number of requests allowed within the window */
  maxRequests: number;
}

interface TokenBucket {
  timestamps: number[];
}

/**
 * In-memory sliding window rate limiter for Hono.
 *
 * Tracks requests by bearer token extracted from the Authorization header.
 * Returns 429 with Retry-After header when the limit is exceeded.
 * Requests without a bearer token are keyed by a fallback identifier.
 */
export function rateLimit({ windowMs, maxRequests }: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, TokenBucket>();

  // Periodic cleanup of stale entries every 60s
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs);
      if (bucket.timestamps.length === 0) {
        buckets.delete(key);
      }
    }
  }, 60_000);

  // Don't block process exit
  if (cleanup.unref) cleanup.unref();

  return async (c, next) => {
    const now = Date.now();
    const key = extractKey(c.req.header("Authorization"));

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      buckets.set(key, bucket);
    }

    // Slide the window: drop timestamps outside the window
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs);

    if (bucket.timestamps.length >= maxRequests) {
      // Compute Retry-After: time until the oldest request in the window expires
      const oldest = bucket.timestamps[0];
      const retryAfterMs = windowMs - (now - oldest);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      return c.json(
        {
          error: "Too Many Requests",
          retryAfter: retryAfterSec,
        },
        429,
        {
          "Retry-After": String(retryAfterSec),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil((oldest + windowMs) / 1000)),
        },
      );
    }

    bucket.timestamps.push(now);

    // Set rate limit headers on successful requests
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(maxRequests - bucket.timestamps.length));
    c.header(
      "X-RateLimit-Reset",
      String(Math.ceil((bucket.timestamps[0] + windowMs) / 1000)),
    );

    return next();
  };
}

/**
 * Extract a rate-limit key from the Authorization header.
 * Uses the bearer token itself so each token gets its own bucket.
 * Falls back to a shared key for unauthenticated requests.
 */
function extractKey(authHeader: string | undefined): string {
  if (!authHeader) return "__anonymous__";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? `bearer:${match[1]}` : "__anonymous__";
}
