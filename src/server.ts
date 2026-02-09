import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bearerAuth } from "./auth.js";
import { boardRoutes } from "./board/routes.js";
import { feedRoutes } from "./feed/routes.js";
import { registryRoutes } from "./registry/routes.js";

const app = new Hono();

// Health check — unauthenticated (used for liveness probes)
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// Auth middleware — protects all routes below
app.use("/*", bearerAuth());

// Mount service routes
app.route("/board", boardRoutes);
app.route("/feed", feedRoutes);
app.route("/registry", registryRoutes);

// TODO: mount these as they're built
// app.route("/skills", skillsRoutes);
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
