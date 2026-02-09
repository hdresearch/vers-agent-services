import type { MiddlewareHandler } from "hono";

/**
 * Bearer token auth middleware.
 *
 * If VERS_AUTH_TOKEN is set, all requests must include:
 *   Authorization: Bearer <token>
 *
 * If VERS_AUTH_TOKEN is NOT set, all requests pass through (dev mode)
 * but a warning is logged on startup.
 */
export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = process.env.VERS_AUTH_TOKEN;

    // No token configured — open access (dev mode)
    if (!token) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return c.json({ error: "Unauthorized — missing Authorization header" }, 401);
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== token) {
      return c.json({ error: "Unauthorized — invalid token" }, 401);
    }

    return next();
  };
}
