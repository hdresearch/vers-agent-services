import { Hono } from "hono";
import { createMagicLink, consumeMagicLink, createSession, validateSession } from "./auth.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

// Login page / magic link consumer
uiRoutes.get("/ui/login", (c) => {
  const token = c.req.query("token");

  if (token) {
    const valid = consumeMagicLink(token);
    if (valid) {
      const session = createSession();
      return c.html(`<html><head><meta http-equiv="refresh" content="0;url=/ui/"></head></html>`, 200, {
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
    return c.redirect("/ui/login");
  }
  return next();
});

// Dashboard
uiRoutes.get("/ui/", (c) => {
  try {
    const html = readFileSync(join(getStaticDir(), "index.html"), "utf-8");
    return c.html(html);
  } catch (e) {
    return c.text("Dashboard files not found", 500);
  }
});

// Report viewer
uiRoutes.get("/ui/report/:id", (c) => {
  try {
    const html = readFileSync(join(getStaticDir(), "report.html"), "utf-8");
    return c.html(html);
  } catch (e) {
    return c.text("Report viewer not found", 500);
  }
});

// Static files
uiRoutes.get("/ui/static/:file", (c) => {
  const file = c.req.param("file");
  // Sanitize
  if (file.includes("..") || file.includes("/")) return c.text("Not found", 404);

  try {
    const content = readFileSync(join(getStaticDir(), file), "utf-8");
    const ext = file.split(".").pop();
    const contentType = ext === "css" ? "text/css" : ext === "js" ? "application/javascript" : "text/plain";
    return c.body(content, 200, { "Content-Type": contentType });
  } catch {
    return c.text("Not found", 404);
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

    const text = await resp.text();
    return c.body(text, resp.status as any, {
      "Content-Type": resp.headers.get("content-type") || "application/json",
    });
  } catch (e) {
    return c.json({ error: "Proxy error", details: String(e) }, 502);
  }
});
