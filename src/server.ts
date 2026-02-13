import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bearerAuth } from "./auth.js";
import { boardRoutes } from "./board/routes.js";
import { feedRoutes } from "./feed/routes.js";
import { logRoutes } from "./log/routes.js";
import { registryRoutes } from "./registry/routes.js";
import { skillsRoutes } from "./skills/routes.js";
import { reportsRoutes, sharePublicRoutes } from "./reports/routes.js";
import { usageRoutes } from "./usage/routes.js";
import { commitRoutes } from "./commits/routes.js";
import { journalRoutes } from "./journal/routes.js";
import { uiRoutes } from "./ui/routes.js";
import { twilioRoutes } from "./twilio/routes.js";

const app = new Hono();

// Health check — unauthenticated (used for liveness probes)
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// Mount UI and auth routes (session auth, not bearer)
app.route("/", uiRoutes);

// Public share link route — NO auth required (must be before bearer auth)
app.route("/reports", sharePublicRoutes);

// Twilio webhook — NO bearer auth (uses X-Twilio-Signature validation)
app.route("/twilio", twilioRoutes);

// Bearer auth — applied per-route to API endpoints
app.use("/board/*", bearerAuth());
app.use("/feed/*", bearerAuth());
app.use("/log/*", bearerAuth());
app.use("/registry/*", bearerAuth());
app.use("/skills/*", bearerAuth());
app.use("/reports/*", bearerAuth());
app.use("/usage/*", bearerAuth());
app.use("/commits/*", bearerAuth());
app.use("/journal/*", bearerAuth());

// Mount service routes
app.route("/board", boardRoutes);
app.route("/feed", feedRoutes);
app.route("/log", logRoutes);
app.route("/registry", registryRoutes);
app.route("/skills", skillsRoutes);
app.route("/reports", reportsRoutes);
app.route("/usage", usageRoutes);
app.route("/commits", commitRoutes);
app.route("/journal", journalRoutes);

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

serve({ fetch: app.fetch, port, hostname: "::" }, () => {
  console.log(`vers-agent-services running on :${port}`);
});

export { app };
