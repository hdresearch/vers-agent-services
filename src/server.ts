import { Hono } from "hono";
import { compress } from "hono/compress";
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
import { couchRoutes, couchPublicRoutes, couchStore } from "./couch/routes.js";
import { fleetChatRoutes, fleetChatPublicRoutes, fleetChatStore } from "./fleet-chat/routes.js";
import { kbRoutes, kbStore } from "./kb/routes.js";
import { daemonRoutes, daemonEngine, daemonStore } from "./daemon/routes.js";
import { contactsRoutes, contactsPublicRoutes, contactsStore } from "./contacts/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import { blogRoutes } from "./blog/routes.js";
import { docsRoutes, docsPublicRoutes, docsStore } from "./docs/routes.js";
import { chatRoutes, chatStore } from "./chat/routes.js";
import { aegisRoutes, aegisStore } from "./aegis/routes.js";
import { deployRoutes } from "./deploy/routes.js";
import { subfleetRoutes, subfleetStore, subfleetOrchestrator, setAegisGuard } from "./subfleet/routes.js";

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

// Couch redeem — NO bearer auth (this is the public door for guest agents)
app.route("/couch", couchPublicRoutes);

// Fleet chat public inbox — NO bearer auth (verified by sender's public key)
app.route("/fleet-chat", fleetChatPublicRoutes);

// Contacts peering accept — NO bearer auth (public door for peer handshake)
app.route("/contacts", contactsPublicRoutes);

// Blog — NO bearer auth (public-facing fleet blog)
app.route("/blog", blogRoutes);

// Docs public routes — NO bearer auth (published docs are public)
app.route("/docs", docsPublicRoutes);

// LLM Router — NO bearer auth on /v1 (agents auth with x-agent-id or fleet token;
// router validates internally). This is the single source of truth for API keys.
app.route("/v1", routerRoutes);

// Gzip compression for all responses > 1KB
app.use("*", compress());

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
app.use("/couch/*", bearerAuth());
// Fleet chat: auth on all routes EXCEPT /inbox (public endpoint)
app.use("/fleet-chat/channels/*", bearerAuth());
app.use("/fleet-chat/identity", bearerAuth());
app.use("/fleet-chat/trusted/*", bearerAuth());
app.use("/fleet-chat/trusted", bearerAuth());
app.use("/fleet-chat/quarantine/*", bearerAuth());
app.use("/fleet-chat/quarantine", bearerAuth());
app.use("/fleet-chat/send", bearerAuth());
app.use("/kb/*", bearerAuth());
app.use("/daemon/*", bearerAuth());
// Contacts: auth on management routes. /peer/accept is public (for peering handshake).
// Note: /:id routes have auth applied at router level in contacts/routes.ts
app.use("/docs", bearerAuth());                // docs registry (public routes mounted separately above)
app.use("/docs/*", bearerAuth());
app.use("/contacts", bearerAuth());            // list + create
app.use("/contacts/from-github/*", bearerAuth());
app.use("/contacts/refresh-keys/*", bearerAuth());
app.use("/contacts/peer/invite", bearerAuth());
app.use("/contacts/peer/invites", bearerAuth());

// ETag for polling-heavy GET endpoints (board, registry, reports, feed)
// Returns 304 Not Modified when data hasn't changed — saves bandwidth on 10-30s polling
app.use("/board/tasks", etag());
app.use("/registry/vms", etag());
app.use("/reports", etag());
app.use("/feed/events", etag());
app.use("/feed/stats", etag());
app.use("/kb/entries", etag());
app.use("/kb/briefing", etag());
app.use("/chat/*", bearerAuth());
app.use("/chat/messages", etag());
app.use("/gossip/*", bearerAuth());
app.use("/loop/*", bearerAuth());
app.use("/aegis/*", bearerAuth());
app.use("/deploy/*", bearerAuth());

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
app.route("/couch", couchRoutes);
app.route("/fleet-chat", fleetChatRoutes);
app.route("/contacts", contactsRoutes);
app.route("/chat", chatRoutes);
app.route("/daemon", daemonRoutes);
app.route("/notifications", notificationRoutes);
app.route("/docs", docsRoutes);
app.route("/aegis", aegisRoutes);
app.route("/deploy", deployRoutes);
app.route("/subfleet", subfleetRoutes);

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

  // Wire up Aegis protection for sub-fleet teardowns
  setAegisGuard((vmId: string) => aegisStore.isProtected(vmId));
});

// Graceful shutdown — let in-flight requests drain before exiting.
// This is critical for zero-downtime deploys: Caddy retries during the brief
// window between SIGTERM and the new process starting.
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  watchdogStore.stop();
  // Flush stores to prevent data loss from debounced writes
  gossipStore.flush();
  // Flush couch store
  couchStore.flush();
  // Flush KB store
  kbStore.flush();
  // Flush fleet-chat store
  fleetChatStore.flush();
  // Graceful loop shutdown — clear timers and wait for active ticks to drain
  if (loopRunnerStore.isRunning) {
    try {
      await loopRunnerStore.shutdown();
      console.log("Loop runner shut down cleanly.");
    } catch (err) {
      console.warn("Loop runner shutdown error:", err);
    }
  }
  // Close contacts DB
  try { contactsStore.close(); } catch {}
  // Close docs DB
  try { docsStore.close(); } catch {}
  // Close chat DB
  try { chatStore.close(); } catch {}
  // Close aegis DB
  try { aegisStore.close(); } catch {}
  // Stop sub-fleet TTL reaper and close DB
  try { subfleetOrchestrator.stopReaper(); } catch {}
  try { subfleetStore.close(); } catch {}
  // Stop daemon event loop
  if (daemonEngine.isRunning) {
    try { daemonEngine.stop(); } catch {}
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











