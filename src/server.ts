import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bearerAuth } from "./auth.js";
import { boardRoutes } from "./board/routes.js";
import { feedRoutes } from "./feed/routes.js";
import { logRoutes } from "./log/routes.js";
import { registryRoutes } from "./registry/routes.js";
import { skillsRoutes } from "./skills/routes.js";
import { uiRoutes } from "./ui/routes.js";

const app = new Hono();

// Health check — unauthenticated (used for liveness probes)
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// Mount UI and auth routes (session auth, not bearer)
app.route("/", uiRoutes);

// Bearer auth — applied per-route to API endpoints
app.use("/board/*", bearerAuth());
app.use("/feed/*", bearerAuth());
app.use("/log/*", bearerAuth());
app.use("/registry/*", bearerAuth());
app.use("/skills/*", bearerAuth());

// Mount service routes
app.route("/board", boardRoutes);
app.route("/feed", feedRoutes);
app.route("/log", logRoutes);
app.route("/registry", registryRoutes);
app.route("/skills", skillsRoutes);

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
