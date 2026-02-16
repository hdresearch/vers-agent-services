import type { MiddlewareHandler } from "hono";
import { getKeyStore } from "./auth/key-routes.js";

/**
 * Bearer token auth middleware.
 *
 * Authentication is checked in order:
 *   1. If VERS_AUTH_TOKEN is set and the bearer token matches → allow (backwards compat)
 *   2. If the bearer token matches a valid (non-revoked) API key in the database → allow
 *   3. If VERS_AUTH_TOKEN is NOT set and no API keys exist → open access (dev mode)
 *   4. Otherwise → 401
 */
export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    const envToken = process.env.VERS_AUTH_TOKEN;
    const authHeader = c.req.header("Authorization");
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    const bearerToken = match?.[1];

    // 1. Check static env token (backwards compat)
    if (envToken && bearerToken === envToken) {
      return next();
    }

    // 2. Check per-agent API keys in the database
    if (bearerToken) {
      try {
        const store = getKeyStore();
        const apiKey = store.verify(bearerToken);
        if (apiKey) {
          // Attach key info to request context for downstream use
          c.set("apiKey", apiKey);
          return next();
        }
      } catch {
        // DB not available — fall through to other checks
      }
    }

    // 3. No env token configured — open access (dev mode)
    if (!envToken) {
      return next();
    }

    // 4. Reject
    if (!authHeader) {
      return c.json({ error: "Unauthorized — missing Authorization header" }, 401);
    }
    return c.json({ error: "Unauthorized — invalid token" }, 401);
  };
}
