/**
 * Gateway Service — port 3000 (public-facing)
 *
 * Reverse proxy to backend services + serves UI static files.
 * The ONLY port exposed to the outside world.
 */

import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import {
  resolveBackend,
  forwardRequest,
  ConcurrencyLimiter,
  HealthChecker,
  BACKENDS,
} from "./router.js";
import { uiRoutes } from "../ui/routes.js";
import { createMagicLink, consumeMagicLink, createSession, validateSession } from "../ui/auth.js";

const app = new Hono();
const limiter = new ConcurrencyLimiter(10);
const healthChecker = new HealthChecker(10_000);

// ── Health & Diagnostics ─────────────────────────────────────────────────────

app.get("/health", (c) => {
  const backends = healthChecker.getAll();
  const allHealthy = backends.every((b) => b.status === "healthy");
  return c.json({
    status: allHealthy ? "ok" : "degraded",
    uptime: process.uptime(),
    backends,
    limiter: limiter.getStats(),
  });
});

app.get("/gateway/status", (c) => {
  return c.json({
    uptime: process.uptime(),
    backends: healthChecker.getAll(),
    limiter: limiter.getStats(),
  });
});

// ── UI Routes (served directly by gateway) ───────────────────────────────────

// Mount UI routes (session auth, static files, magic link)
app.route("/", uiRoutes);

// ── Compression ──────────────────────────────────────────────────────────────

app.use("*", compress());

// ── Reverse Proxy (catch-all) ────────────────────────────────────────────────

app.all("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const backend = resolveBackend(path);

  if (!backend) {
    return c.json({ error: "Not found" }, 404);
  }

  // Check backend health — return 503 if down
  if (!healthChecker.isHealthy(backend)) {
    const config = BACKENDS[backend];
    return c.json(
      {
        error: `Service unavailable — ${config?.name || backend} is not responding`,
        backend: config?.name || backend,
      },
      503,
    );
  }

  try {
    const { response, latencyMs } = await forwardRequest(c.req.raw, backend, limiter);

    // Build the response — forward status, headers, and body
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("X-Backend", backend);
    responseHeaders.set("X-Backend-Latency", `${latencyMs}ms`);
    // Remove hop-by-hop headers from response
    responseHeaders.delete("connection");
    responseHeaders.delete("keep-alive");
    responseHeaders.delete("transfer-encoding");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return c.json(
        { error: `Gateway timeout — ${backend} did not respond within 30s` },
        504,
      );
    }
    console.error(`[gateway] Error forwarding to ${backend}:`, err);
    return c.json(
      { error: `Bad gateway — ${backend} error: ${err?.message || "unknown"}` },
      502,
    );
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.GATEWAY_PORT || process.env.PORT || "3000", 10);

const server = serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(`[gateway] running on :${port}`);
  healthChecker.start();
  console.log(`[gateway] health checker started — polling backends every 10s`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[gateway] ${signal} received — shutting down...`);
  healthChecker.stop();
  server.close(() => {
    console.log("[gateway] closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[gateway] force exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };
