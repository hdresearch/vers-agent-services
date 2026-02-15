import { Hono } from "hono";
import { DaemonEngine, type DaemonDeps } from "./engine.js";
import { DaemonStore } from "./store.js";
import { eventLogStore } from "../events/store.js";
import { ConfigStore } from "../config/store.js";

// --- Singleton daemon ---

const daemonStore = new DaemonStore();
const configStore = new ConfigStore();

const deps: DaemonDeps = {
  eventStore: eventLogStore,
  configStore,
  daemonStore,
  selfBaseUrl: `http://localhost:${process.env.PORT || "3000"}`,
  authToken: process.env.VERS_AUTH_TOKEN || "",
};

const engine = new DaemonEngine(deps);

export { engine as daemonEngine, daemonStore };

// --- Routes ---

export const daemonRoutes = new Hono();

// GET /status — is it running, uptime, recent actions, cursor position
daemonRoutes.get("/status", (c) => {
  return c.json(engine.getStatus());
});

// POST /start — start the event loop
daemonRoutes.post("/start", async (c) => {
  if (engine.isRunning) {
    return c.json({ message: "daemon already running" }, 200);
  }
  await engine.start();
  return c.json({ message: "daemon started", status: engine.getStatus() }, 200);
});

// POST /stop — stop the event loop
daemonRoutes.post("/stop", (c) => {
  if (!engine.isRunning) {
    return c.json({ message: "daemon not running" }, 200);
  }
  engine.stop();
  return c.json({ message: "daemon stopped" }, 200);
});

// GET /actions — log of all autonomous actions taken
daemonRoutes.get("/actions", (c) => {
  const limitStr = c.req.query("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : 100;
  const actions = daemonStore.getActions(limit);
  return c.json({ actions, count: actions.length, total: daemonStore.getActionCount() });
});
