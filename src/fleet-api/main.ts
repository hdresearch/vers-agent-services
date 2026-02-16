/**
 * Fleet API Service — port 3002
 *
 * Fleet-chat, contacts, couch, gossip, registry, twilio.
 * External-facing fleet communication services.
 */

import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { bearerAuth } from "../auth.js";
import { etag } from "../middleware/etag.js";

// Route imports
import { registryRoutes, registryStore } from "../registry/routes.js";
import { initPersistentVMs } from "../registry/persistent.js";
import { gossipRoutes, gossipStore } from "../gossip/routes.js";
import { couchRoutes, couchPublicRoutes, couchStore } from "../couch/routes.js";
import { fleetChatRoutes, fleetChatPublicRoutes, fleetChatStore } from "../fleet-chat/routes.js";
import { contactsRoutes, contactsPublicRoutes, contactsStore } from "../contacts/routes.js";
import { twilioRoutes } from "../twilio/routes.js";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "fleet-api", uptime: process.uptime() }));

// Public routes (no auth)
app.route("/twilio", twilioRoutes);
app.route("/couch", couchPublicRoutes);
app.route("/fleet-chat", fleetChatPublicRoutes);
app.route("/contacts", contactsPublicRoutes);

// Compression
app.use("*", compress());

// Bearer auth
app.use("/registry/*", bearerAuth());
app.use("/gossip/*", bearerAuth());
app.use("/couch/*", bearerAuth());
app.use("/fleet-chat/channels/*", bearerAuth());
app.use("/fleet-chat/identity", bearerAuth());
app.use("/fleet-chat/trusted/*", bearerAuth());
app.use("/fleet-chat/trusted", bearerAuth());
app.use("/fleet-chat/quarantine/*", bearerAuth());
app.use("/fleet-chat/quarantine", bearerAuth());
app.use("/fleet-chat/send", bearerAuth());
app.use("/contacts", bearerAuth());
app.use("/contacts/from-github/*", bearerAuth());
app.use("/contacts/refresh-keys/*", bearerAuth());
app.use("/contacts/peer/invite", bearerAuth());
app.use("/contacts/peer/invites", bearerAuth());

// ETag
app.use("/registry/vms", etag());

// Mount routes
app.route("/registry", registryRoutes);
app.route("/gossip", gossipRoutes);
app.route("/couch", couchRoutes);
app.route("/fleet-chat", fleetChatRoutes);
app.route("/contacts", contactsRoutes);

// ── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.FLEET_API_PORT || "3002", 10);

const server = serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(`[fleet-api] running on :${port}`);
  initPersistentVMs();
  console.log(`[fleet-api] persistent VMs initialized`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[fleet-api] ${signal} received — shutting down...`);
  gossipStore.flush();
  couchStore.flush();
  fleetChatStore.flush();
  try { contactsStore.close(); } catch {}
  server.close(() => {
    console.log("[fleet-api] closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[fleet-api] force exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };
