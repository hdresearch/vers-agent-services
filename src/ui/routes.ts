import { Hono } from "hono";
import { createMagicLink, consumeMagicLink, createSession, validateSession } from "./auth.js";
import { processAnalyticsQuery } from "./analytics.js";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const uiRoutes = new Hono();

const AUTH_TOKEN = process.env.VERS_AUTH_TOKEN || "test-token";

// Resolve static file directory
function getStaticDir(): string {
  // In compiled JS, __dirname equivalent
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, "static");
  } catch {
    return join(process.cwd(), "dist", "ui", "static");
  }
}

// ─── In-memory static file cache ───
// Loaded once at startup — no readFileSync per request, no per-request hashing.

interface CachedFile {
  content: string;
  contentType: string;
  etag: string;
}

const staticCache = new Map<string, CachedFile>();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function loadStaticFiles(): void {
  const dir = getStaticDir();
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const ext = extname(file);
        const hash = createHash("md5").update(content).digest("hex").slice(0, 16);
        staticCache.set(file, {
          content,
          contentType: CONTENT_TYPES[ext] || "text/plain",
          etag: `W/"${hash}"`,
        });
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // static dir missing — will 404 at serve time
  }
}

// Load on module init (startup)
loadStaticFiles();

/** Async fallback for files not in cache (e.g. added after startup). */
async function getStaticFile(file: string): Promise<CachedFile | null> {
  const cached = staticCache.get(file);
  if (cached) return cached;
  try {
    const content = await readFile(join(getStaticDir(), file), "utf-8");
    const ext = extname(file);
    const hash = createHash("md5").update(content).digest("hex").slice(0, 16);
    const entry: CachedFile = {
      content,
      contentType: CONTENT_TYPES[ext] || "text/plain",
      etag: `W/"${hash}"`,
    };
    staticCache.set(file, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Force-reload the static cache (useful after deploys). */
export function reloadStaticCache(): void {
  staticCache.clear();
  loadStaticFiles();
}

// Helper to parse session cookie
function getSessionId(c: any): string | undefined {
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match?.[1];
}

// Helper to check bearer auth
function hasBearerAuth(c: any): boolean {
  const auth = c.req.header("authorization") || "";
  return auth === `Bearer ${AUTH_TOKEN}`;
}

// ─── Auth Routes ───

// Generate magic link (requires bearer auth)
uiRoutes.post("/auth/magic-link", async (c) => {
  if (!hasBearerAuth(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const link = createMagicLink();
  const host = c.req.header("host") || "localhost:3000";
  const proto = c.req.header("x-forwarded-proto") || "https";
  const url = `${proto}://${host}/ui/login?token=${link.token}`;

  return c.json({ url, expiresAt: link.expiresAt });
});

// Generate deep link — magic link with redirect to a specific UI path
uiRoutes.post("/auth/deep-link", async (c) => {
  if (!hasBearerAuth(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const path = (body as any).path || "/ui/";
  // Sanitize path
  const safePath = (path.startsWith("/ui/") || path.startsWith("/ui#")) ? path : "/ui/";

  const link = createMagicLink();
  const host = c.req.header("host") || "localhost:3000";
  const proto = c.req.header("x-forwarded-proto") || "https";
  const redirect = encodeURIComponent(safePath);
  const url = `${proto}://${host}/ui/login?token=${link.token}&redirect=${redirect}`;

  return c.json({ url, path: safePath, expiresAt: link.expiresAt });
});

// Login page / magic link consumer
uiRoutes.get("/ui/login", (c) => {
  const token = c.req.query("token");

  if (token) {
    const valid = consumeMagicLink(token);
    if (valid) {
      const session = createSession();
      // Support redirect param for deep links (e.g. /ui/#comms)
      const redirect = c.req.query("redirect") || "/ui/";
      // Sanitize: only allow paths starting with /ui/ to prevent open redirect
      const safeDest = redirect.startsWith("/ui/") || redirect.startsWith("/ui#") ? redirect : "/ui/";
      return c.html(`<html><head><meta http-equiv="refresh" content="0;url=${safeDest}"></head></html>`, 200, {
        "Set-Cookie": `session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      });
    }
    return c.html(`
      <html><body style="background:#111;color:#e44;font-family:monospace;padding:2em">
        <h2>Invalid or expired link</h2>
        <p>Request a new magic link from the API.</p>
      </body></html>
    `, 401);
  }

  return c.html(`
    <html><body style="background:#111;color:#888;font-family:monospace;padding:2em">
      <h2>Agent Services Dashboard</h2>
      <p>Access requires a magic link. Generate one via:</p>
      <pre style="color:#6f6">POST /auth/magic-link</pre>
    </body></html>
  `);
});

// ─── Session-protected UI routes ───

// Middleware for /ui/* (except /ui/login)
uiRoutes.use("/ui/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/ui/login" || path.startsWith("/ui/static/")) return next();

  const sessionId = getSessionId(c);
  if (!validateSession(sessionId)) {
    // API calls get 401 JSON (so fetch can detect it), pages get redirect
    if (path.startsWith("/ui/api/")) {
      return c.json({ error: "Session expired" }, 401);
    }
    return c.redirect("/ui/login");
  }
  return next();
});

// Dashboard
uiRoutes.get("/ui/", async (c) => {
  const file = await getStaticFile("index.html");
  if (!file) return c.text("Dashboard files not found", 500);
  return c.html(file.content);
});

// Fleet Command dashboard
uiRoutes.get("/ui/command", async (c) => {
  const file = await getStaticFile("command.html");
  if (!file) return c.text("Command dashboard not found", 500);
  return c.html(file.content);
});

// Dashboard v2 — Micro-UI panels
uiRoutes.get("/ui/v2", async (c) => {
  const file = await getStaticFile("dashboard-v2.html");
  if (!file) return c.text("Dashboard v2 not found", 500);
  return c.html(file.content);
});

// PM tool
uiRoutes.get("/ui/pm", async (c) => {
  const file = await getStaticFile("pm.html");
  if (!file) return c.text("PM tool not found", 500);
  return c.html(file.content);
});

// Usage dashboard
uiRoutes.get("/ui/usage", async (c) => {
  const file = await getStaticFile("index.html");
  if (!file) return c.text("Dashboard files not found", 500);
  return c.html(file.content);
});

// Report viewer
uiRoutes.get("/ui/report/:id", async (c) => {
  const file = await getStaticFile("report.html");
  if (!file) return c.text("Report viewer not found", 500);
  return c.html(file.content);
});

// Static files — served from in-memory cache, async fallback for uncached files
uiRoutes.get("/ui/static/:file", async (c) => {
  const fileName = c.req.param("file");
  // Sanitize
  if (fileName.includes("..") || fileName.includes("/")) return c.text("Not found", 404);

  const file = await getStaticFile(fileName);
  if (!file) return c.text("Not found", 404);

  // Return 304 if unchanged
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch === file.etag) {
    return c.body(null, 304, { ETag: file.etag });
  }

  // Long cache for CSS/JS (fingerprinted or revalidated via ETag), short for others
  const ext = extname(fileName);
  const maxAge = ext === ".css" || ext === ".js" ? 86400 : 3600;

  return c.body(file.content, 200, {
    "Content-Type": file.contentType,
    "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=86400`,
    "ETag": file.etag,
  });
});

// ─── Analytics Query Endpoint ───

uiRoutes.post("/ui/api/analytics/query", async (c) => {
  // Session auth check
  const sessionId = getSessionId(c);
  if (!validateSession(sessionId)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const question = body.question || body.q || "";
    const result = await processAnalyticsQuery(question);
    return c.json(result);
  } catch (e: any) {
    return c.json({ answer: `Error: ${e.message}` }, 500);
  }
});

// ─── API Proxy (injects bearer token so browser JS doesn't need it) ───

uiRoutes.all("/ui/api/*", async (c) => {
  // Strip /ui/api prefix to get real API path
  const url = new URL(c.req.url);
  const apiPath = url.pathname.replace(/^\/ui\/api/, "");
  const queryString = url.search;

  // Build internal URL
  const port = process.env.PORT || "3000";
  const internalUrl = `http://127.0.0.1:${port}${apiPath}${queryString}`;

  // Forward the request
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${AUTH_TOKEN}`,
  };

  const contentType = c.req.header("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  // Forward conditional request headers for ETag support
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;

  const method = c.req.method;
  const body = method !== "GET" && method !== "HEAD" ? await c.req.text() : undefined;

  try {
    const resp = await fetch(internalUrl, { method, headers, body });

    // For SSE streams, pipe through
    if (resp.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Forward 304 Not Modified as-is (ETag polling optimization)
    if (resp.status === 304) {
      const respHeaders: Record<string, string> = {};
      const respEtag = resp.headers.get("etag");
      if (respEtag) respHeaders["ETag"] = respEtag;
      return c.body(null, 304, respHeaders);
    }

    const text = await resp.text();
    const respHeaders: Record<string, string> = {
      "Content-Type": resp.headers.get("content-type") || "application/json",
    };
    const respEtag = resp.headers.get("etag");
    if (respEtag) respHeaders["ETag"] = respEtag;
    return c.body(text, resp.status as any, respHeaders);
  } catch (e) {
    return c.json({ error: "Proxy error", details: String(e) }, 502);
  }
});

