/**
 * Autonomy API Service — port 3003
 *
 * Daemon, loop, aegis, deploy, webhooks.
 * Agent lifecycle management and autonomous operations.
 */

import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { bearerAuth } from "../auth.js";

// Route imports
import { aegisRoutes, aegisStore } from "../aegis/routes.js";
import { daemonRoutes, daemonEngine, daemonStore } from "../daemon/routes.js";
import { deployRoutes } from "../deploy/routes.js";
import { loopRoutes, loopStore as loopRunnerStore } from "../loop/routes.js";
import { webhookRoutes } from "../webhooks/routes.js";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "autonomy-api", uptime: process.uptime() }));

// Public routes (no auth)
app.route("/webhooks", webhookRoutes);

// Compression
app.use("*", compress());

// Bearer auth
app.use("/aegis/*", bearerAuth());
app.use("/daemon/*", bearerAuth());
app.use("/deploy/*", bearerAuth());
app.use("/loop/*", bearerAuth());

// Mount routes
app.route("/aegis", aegisRoutes);
app.route("/daemon", daemonRoutes);
app.route("/deploy", deployRoutes);
app.route("/loop", loopRoutes);

// ── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.AUTONOMY_API_PORT || "3003", 10);

const server = serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(`[autonomy-api] running on :${port}`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[autonomy-api] ${signal} received — shutting down...`);

  try { aegisStore.close(); } catch {}

  if (loopRunnerStore.isRunning) {
    try {
      await loopRunnerStore.shutdown();
      console.log("[autonomy-api] loop runner shut down");
    } catch (err) {
      console.warn("[autonomy-api] loop runner shutdown error:", err);
    }
  }

  if (daemonEngine.isRunning) {
    try { daemonEngine.stop(); } catch {}
  }

  server.close(() => {
    console.log("[autonomy-api] closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[autonomy-api] force exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };
