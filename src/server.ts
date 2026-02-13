import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ServiceLoader } from "./service-loader.js";
import { uiRoutes } from "./ui/routes.js";
import { sharePublicRoutes } from "./reports/manifest.js";
import { rateLimit } from "./middleware/rate-limit.js";

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
import { manifest as configManifest } from "./config/manifest.js";
import { manifest as twilioManifest } from "./twilio/manifest.js";
import { manifest as authManifest } from "./auth/manifest.js";

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
loader.register(configManifest);
loader.register(twilioManifest);
loader.register(authManifest);

// ─── Health check — unauthenticated ───
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// ─── UI routes (session auth, not bearer) ───
app.route("/", uiRoutes);

// ─── Public share link route — NO auth ───
app.route("/reports", sharePublicRoutes);

// ─── Rate limiting for write endpoints (applied before service mount) ───
app.post("/feed/events", rateLimit({ windowMs: 60_000, maxRequests: 60 }));
app.post("/log", rateLimit({ windowMs: 60_000, maxRequests: 30 }));
app.post("/board/tasks", rateLimit({ windowMs: 60_000, maxRequests: 30 }));

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
