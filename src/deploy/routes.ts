import { Hono } from "hono";
import { DeployStore } from "./store.js";
import { executeDeploy, isDeploying } from "./executor.js";
import { emit } from "../events/emit.js";

export const deployStore = new DeployStore();
export const deployRoutes = new Hono();

// POST /trigger — Trigger a deploy
deployRoutes.post("/trigger", async (c) => {
  if (isDeploying()) {
    return c.json({ error: "Deploy already in progress" }, 409);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const branch = body.branch || "main";
  const commit = body.commit || undefined;
  const triggeredBy = body.triggeredBy || "api";

  emit("deploy", "deploy.triggered", { branch, commit, triggeredBy }, triggeredBy);

  // Return a tracking ID immediately — deploy runs in background
  const trackingId = `deploy-${Date.now()}`;

  // Execute in background (executeDeploy creates its own record in the store)
  (async () => {
    try {
      const result = await executeDeploy(deployStore, branch, commit, triggeredBy);
      emit("deploy", "deploy.completed", {
        branch,
        success: result.success,
        commit: result.commit,
        deployId: result.id,
      }, triggeredBy);
    } catch (err: any) {
      emit("deploy", "deploy.failed", {
        branch,
        error: err?.message,
      }, triggeredBy);
    }
  })();

  return c.json({
    message: "Deploy triggered",
    branch,
    commit: commit || "latest",
  }, 202);
});

// GET /status — Current deploy status
deployRoutes.get("/status", (c) => {
  const status = deployStore.getStatus();
  return c.json(status);
});

// GET /history — Deploy history
deployRoutes.get("/history", (c) => {
  const limitStr = c.req.query("limit");
  const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 20, 50) : 20;
  const history = deployStore.getHistory(limit);
  return c.json({ deploys: history, count: history.length });
});
