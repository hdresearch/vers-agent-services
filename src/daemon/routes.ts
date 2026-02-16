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

// POST /snapshot — trigger a manual infra snapshot
daemonRoutes.post("/snapshot", async (c) => {
  try {
    const commitId = await engine.performSnapshot("manual");
    return c.json({ message: "snapshot created", commitId }, 200);
  } catch (err) {
    return c.json(
      { error: "snapshot failed", detail: (err as Error).message },
      500,
    );
  }
});

// GET /snapshot/config — get auto-snapshot config
daemonRoutes.get("/snapshot/config", (c) => {
  const enabled = configStore.get("AUTO_SNAPSHOT_ENABLED");
  const vmId = configStore.get("INFRA_VM_ID");
  return c.json({
    autoSnapshotEnabled: enabled?.value === "true",
    infraVmId: vmId?.value || "a9a83d7f-c092-404a-bf44-cf21b96a2170",
  });
});

// POST /snapshot/config — enable/disable auto-snapshots
daemonRoutes.post("/snapshot/config", async (c) => {
  const body = await c.req.json();
  if (typeof body.enabled === "boolean") {
    configStore.set("AUTO_SNAPSHOT_ENABLED", String(body.enabled), "config");
  }
  if (typeof body.infraVmId === "string" && body.infraVmId.trim()) {
    configStore.set("INFRA_VM_ID", body.infraVmId.trim(), "config");
  }
  const enabled = configStore.get("AUTO_SNAPSHOT_ENABLED");
  const vmId = configStore.get("INFRA_VM_ID");
  return c.json({
    autoSnapshotEnabled: enabled?.value === "true",
    infraVmId: vmId?.value || "a9a83d7f-c092-404a-bf44-cf21b96a2170",
    message: "config updated",
  });
});
