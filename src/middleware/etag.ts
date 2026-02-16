import { createHash } from "node:crypto";
import type { Context, Next } from "hono";

/**
 * Lightweight ETag middleware for JSON API responses.
 * Computes a weak ETag from the response body and returns 304
 * if the client sends a matching If-None-Match header.
 *
 * This dramatically reduces bandwidth for polling endpoints
 * (board, registry, reports) where data changes infrequently.
 */
export function etag() {
  return async (c: Context, next: Next) => {
    await next();

    // Only apply to successful JSON GET responses
    if (
      c.req.method !== "GET" ||
      c.res.status !== 200 ||
      !c.res.headers.get("content-type")?.includes("application/json")
    ) {
      return;
    }

    // Clone the response to read the body
    const body = await c.res.text();
    const hash = createHash("md5").update(body).digest("hex").slice(0, 16);
    const etagValue = `W/"${hash}"`;

    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch === etagValue) {
      c.res = new Response(null, {
        status: 304,
        headers: { ETag: etagValue },
      });
      return;
    }

    // Rebuild response with ETag header
    c.res = new Response(body, {
      status: c.res.status,
      headers: {
        ...Object.fromEntries(c.res.headers.entries()),
        ETag: etagValue,
        "Cache-Control": "no-cache", // must revalidate
      },
    });
  };
}
