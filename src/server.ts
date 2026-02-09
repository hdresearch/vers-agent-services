import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { boardRoutes } from "./board/routes.js";
import { feedRoutes } from "./feed/routes.js";
import { registryRoutes } from "./registry/routes.js";
import { skillsRoutes } from "./skills/routes.js";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// Mount service routes
app.route("/board", boardRoutes);
app.route("/feed", feedRoutes);
app.route("/registry", registryRoutes);
app.route("/skills", skillsRoutes);

// TODO: mount these as they're built
// app.route("/context", contextRoutes);
// app.route("/cost", costRoutes);

const port = parseInt(process.env.PORT || "3000", 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`vers-agent-services running on :${port}`);
});

export { app };
