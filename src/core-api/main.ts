/**
 * Core API Service — port 3001
 *
 * Board, feed, log, reports, KB, journal, skills, personas, cryo, commits,
 * config, notifications, usage, events, review, watchdog, chat, auth, docs,
 * blog, router (LLM).
 *
 * This is the "read/write state" service — the heart of agent-services.
 */

import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { bearerAuth } from "../auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { etag } from "../middleware/etag.js";

// Route imports
import { keyRoutes } from "../auth/key-routes.js";
import { boardRoutes } from "../board/routes.js";
import { feedRoutes } from "../feed/routes.js";
import { logRoutes } from "../log/routes.js";
import { skillsRoutes } from "../skills/routes.js";
import { reportsRoutes, sharePublicRoutes } from "../reports/routes.js";
import { usageRoutes } from "../usage/routes.js";
import { commitRoutes } from "../commits/routes.js";
import { journalRoutes } from "../journal/routes.js";
import { configRoutes } from "../config/routes.js";
import { kbRoutes, kbStore } from "../kb/routes.js";
import { reviewRoutes } from "../review/routes.js";
import { eventRoutes } from "../events/routes.js";
import { personaRoutes } from "../personas/routes.js";
import { cryoRoutes } from "../cryo/routes.js";
import { notificationRoutes } from "../notifications/routes.js";
import { chatRoutes, chatStore } from "../chat/routes.js";
import { createWatchdogRoutes } from "../watchdog/routes.js";
import { feedStore } from "../feed/routes.js";
import { store as boardStore } from "../board/routes.js";
import { RegistryStore } from "../registry/store.js";

// Watchdog needs a registry store — in microservices mode we create a local
// instance. The watchdog will only see agents that registered via this process.
// For full fleet visibility, deploy the monolith or add an HTTP adapter later.
const registryStore = new RegistryStore();
import { routerRoutes } from "../router/routes.js";
import { docsRoutes, docsPublicRoutes, docsStore } from "../docs/routes.js";
import { blogRoutes } from "../blog/routes.js";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "core-api", uptime: process.uptime() }));

// Public routes (no auth)
app.route("/reports", sharePublicRoutes);
app.route("/v1", routerRoutes);
app.route("/docs", docsPublicRoutes);
app.route("/blog", blogRoutes);

// Compression
app.use("*", compress());

// Bearer auth per-route
app.use("/auth/*", bearerAuth());
app.use("/board/*", bearerAuth());
app.use("/feed/*", bearerAuth());
app.use("/log/*", bearerAuth());
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
app.use("/chat/*", bearerAuth());
app.use("/docs", bearerAuth());
app.use("/docs/*", bearerAuth());

// ETag for polling-heavy endpoints
app.use("/board/tasks", etag());
app.use("/reports", etag());
app.use("/feed/events", etag());
app.use("/feed/stats", etag());
app.use("/kb/entries", etag());
app.use("/kb/briefing", etag());
app.use("/chat/messages", etag());

// Rate limiting
app.post("/feed/events", rateLimit({ windowMs: 60_000, maxRequests: 60 }));
app.post("/log", rateLimit({ windowMs: 60_000, maxRequests: 30 }));
app.post("/board/tasks", rateLimit({ windowMs: 60_000, maxRequests: 30 }));
app.post("/events", rateLimit({ windowMs: 60_000, maxRequests: 60 }));

// Mount routes
app.route("/auth", keyRoutes);
app.route("/board", boardRoutes);
app.route("/feed", feedRoutes);
app.route("/log", logRoutes);
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
app.route("/kb", kbRoutes);
app.route("/chat", chatRoutes);
app.route("/notifications", notificationRoutes);
app.route("/docs", docsRoutes);

// Watchdog
const { routes: watchdogRoutes, store: watchdogStore } = createWatchdogRoutes(
  feedStore,
  registryStore,
  boardStore,
);
app.use("/watchdog/*", bearerAuth());
app.route("/watchdog", watchdogRoutes);

// ── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.CORE_API_PORT || "3001", 10);

const server = serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(`[core-api] running on :${port}`);
  watchdogStore.start();
  console.log(`[core-api] watchdog started`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[core-api] ${signal} received — shutting down...`);
  watchdogStore.stop();
  kbStore.flush();
  try { chatStore.close(); } catch {}
  try { docsStore.close(); } catch {}
  server.close(() => {
    console.log("[core-api] closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[core-api] force exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };
