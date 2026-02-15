import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bearerAuth } from "./auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { etag } from "./middleware/etag.js";
import { keyRoutes } from "./auth/key-routes.js";
import { boardRoutes } from "./board/routes.js";
import { feedRoutes } from "./feed/routes.js";
import { logRoutes } from "./log/routes.js";
import { registryRoutes } from "./registry/routes.js";
import { initPersistentVMs } from "./registry/persistent.js";
import { skillsRoutes } from "./skills/routes.js";
import { reportsRoutes, sharePublicRoutes } from "./reports/routes.js";
import { usageRoutes } from "./usage/routes.js";
import { commitRoutes } from "./commits/routes.js";
import { journalRoutes } from "./journal/routes.js";
import { configRoutes } from "./config/routes.js";
import { uiRoutes } from "./ui/routes.js";
import { twilioRoutes } from "./twilio/routes.js";
import { createWatchdogRoutes } from "./watchdog/routes.js";
import { feedStore } from "./feed/routes.js";
import { registryStore } from "./registry/routes.js";
import { store as boardStore } from "./board/routes.js";
import { webhookRoutes } from "./webhooks/routes.js";
import { reviewRoutes } from "./review/routes.js";
import { eventRoutes } from "./events/routes.js";
import { personaRoutes } from "./personas/routes.js";
import { cryoRoutes } from "./cryo/routes.js";
import { gossipRoutes, gossipStore } from "./gossip/routes.js";
import { loopRoutes, loopStore as loopRunnerStore } from "./loop/routes.js";
import { routerRoutes } from "./router/routes.js";
import { kbRoutes, kbStore } from "./kb/routes.js";

const app = new Hono();

// Health check — unauthenticated (used for liveness probes)
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// Mount UI and auth routes (session auth, not bearer)
app.route("/", uiRoutes);

// Public share link route — NO auth required (must be before bearer auth)
app.route("/reports", sharePublicRoutes);

// Twilio webhook — NO bearer auth (uses X-Twilio-Signature validation)
app.route("/twilio", twilioRoutes);

// Gitea webhook — NO bearer auth (uses HMAC signature validation)
app.route("/webhooks", webhookRoutes);

// LLM Router — NO bearer auth on /v1 (agents auth with x-agent-id or fleet token;
// router validates internally). This is the single source of truth for API keys.
app.route("/v1", routerRoutes);

// Bearer auth — applied per-route to API endpoints
app.use("/auth/*", bearerAuth());
app.use("/board/*", bearerAuth());
app.use("/feed/*", bearerAuth());
app.use("/log/*", bearerAuth());
app.use("/registry/*", bearerAuth());
app.use("/skills/*", bearerAuth());
app.use("/reports/*", bearerAuth());
app.use("/usage/*", bearerAuth());
app.use("/commits/*", bearerAuth());
app.use("/journal/*", bearerAuth());
app.use("/config/*", bearerAuth());
app.use("/review/*", bearerAuth());
app.use("/events/*", bearerAuth());
app.use("/personas/*", bearerAuth());
app.use("/cryo/*", bearerAuth());
app.use("/kb/*", bearerAuth());

// ETag for polling-heavy GET endpoints (board, registry, reports, feed)
// Returns 304 Not Modified when data hasn't changed — saves bandwidth on 10-30s polling
app.use("/board/tasks", etag());
app.use("/registry/vms", etag());
app.use("/reports", etag());
app.use("/feed/events", etag());
app.use("/feed/stats", etag());
app.use("/kb/entries", etag());
app.use("/kb/briefing", etag());
app.use("/gossip/*", bearerAuth());
app.use("/loop/*", bearerAuth());

// Rate limiting for write endpoints (applied after auth)
app.post("/feed/events", rateLimit({ windowMs: 60_000, maxRequests: 60 }));
app.post("/log", rateLimit({ windowMs: 60_000, maxRequests: 30 }));
app.post("/board/tasks", rateLimit({ windowMs: 60_000, maxRequests: 30 }));
app.post("/events", rateLimit({ windowMs: 60_000, maxRequests: 60 }));

// Mount service routes
app.route("/auth", keyRoutes);
app.route("/board", boardRoutes);
app.route("/feed", feedRoutes);
app.route("/log", logRoutes);
app.route("/registry", registryRoutes);
app.route("/skills", skillsRoutes);
app.route("/reports", reportsRoutes);
app.route("/usage", usageRoutes);
app.route("/commits", commitRoutes);
app.route("/journal", journalRoutes);
app.route("/config", configRoutes);
app.route("/review", reviewRoutes);
app.route("/events", eventRoutes);
app.route("/personas", personaRoutes);
app.route("/cryo", cryoRoutes);
app.route("/gossip", gossipRoutes);
app.route("/kb", kbRoutes);
app.route("/loop", loopRoutes);

// Watchdog — zombie agent detection
const { routes: watchdogRoutes, store: watchdogStore } = createWatchdogRoutes(
  feedStore,
  registryStore,
  boardStore,
);
app.use("/watchdog/*", bearerAuth());
app.route("/watchdog", watchdogRoutes);

// TODO: mount these as they're built
// app.route("/context", contextRoutes);
// app.route("/cost", costRoutes);

const port = parseInt(process.env.PORT || "3000", 10);

if (!process.env.VERS_AUTH_TOKEN) {
  console.warn(
    "⚠️  VERS_AUTH_TOKEN is not set — all endpoints are unauthenticated.\n" +
    "   Set VERS_AUTH_TOKEN to enable bearer token auth for production use."
  );
}

const server = serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(`vers-agent-services running on :${port}`);
  // Auto-start zombie watchdog
  watchdogStore.start();
  console.log(`watchdog started — checking every 2min for zombie agents`);

  // Auto-register persistent VMs (infra, gitea, minio) and start heartbeat loop.
  // This ensures they survive TTL purging without manual intervention.
  initPersistentVMs();
});

// Graceful shutdown — let in-flight requests drain before exiting.
// This is critical for zero-downtime deploys: Caddy retries during the brief
// window between SIGTERM and the new process starting.
function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  watchdogStore.stop();
  // Flush stores to prevent data loss from debounced writes
  gossipStore.flush();
  kbStore.flush();
  // Stop loop runner timers
  if (loopRunnerStore.isRunning) {
    try { loopRunnerStore.stop(); } catch {}
  }
  server.close(() => {
    console.log("All connections closed. Exiting.");
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    console.warn("Forceful shutdown after 10s timeout.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };

