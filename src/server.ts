import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ServiceLoader } from "./service-loader.js";
import { uiRoutes } from "./ui/routes.js";
import { sharePublicRoutes } from "./reports/manifest.js";

// Import all service manifests
import { manifest as boardManifest } from "./board/manifest.js";
import { manifest as feedManifest } from "./feed/manifest.js";
import { manifest as logManifest } from "./log/manifest.js";
import { manifest as registryManifest } from "./registry/manifest.js";
import { manifest as skillsManifest } from "./skills/manifest.js";
import { manifest as reportsManifest } from "./reports/manifest.js";
import { manifest as usageManifest } from "./usage/manifest.js";
import { manifest as commitManifest } from "./commits/manifest.js";
import { manifest as journalManifest } from "./journal/manifest.js";

const app = new Hono();
const loader = new ServiceLoader();

// ─── Register all services ───
console.log("Loading services…");
loader.register(boardManifest);
loader.register(feedManifest);
loader.register(logManifest);
loader.register(registryManifest);
loader.register(skillsManifest);
loader.register(reportsManifest);
loader.register(usageManifest);
loader.register(commitManifest);
loader.register(journalManifest);

// ─── Health check — unauthenticated ───
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// ─── UI routes (session auth, not bearer) ───
app.route("/", uiRoutes);

// ─── Public share link route — NO auth ───
app.route("/reports", sharePublicRoutes);

// ─── Mount all service routes (with auth) ───
await loader.mount(app);

// ─── UI manifest endpoint (served via session-auth proxy at /ui/api/manifest) ───
app.get("/manifest", (c) => {
  return c.json(loader.getUIManifest());
});

// ─── Start ───
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

export { app, loader };
