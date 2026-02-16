import { Hono } from "hono";
import {
  registerAgent,
  getBriefing,
  heartbeat,
  debrief,
} from "./protocol.js";

export const bootRoutes = new Hono();

// POST /register — Agent calls on first wake
bootRoutes.post("/register", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.vmId || typeof body.vmId !== "string") {
      return c.json({ error: "vmId is required" }, 400);
    }

    const result = registerAgent({
      vmId: body.vmId,
      name: body.name,
      taskHint: body.taskHint,
    });

    return c.json(result, 201);
  } catch (e: any) {
    if (e.message?.includes("required")) {
      return c.json({ error: e.message }, 400);
    }
    // Conflict (agent name already taken, etc.)
    if (e.message?.includes("already exists")) {
      return c.json({ error: e.message }, 409);
    }
    console.error("[boot] register error:", e);
    return c.json({ error: e.message || "internal error" }, 500);
  }
});

// GET /briefing/:agentName — Everything an agent needs to orient
bootRoutes.get("/briefing/:agentName", (c) => {
  try {
    const agentName = c.req.param("agentName");
    const result = getBriefing(agentName);
    return c.json(result);
  } catch (e: any) {
    console.error("[boot] briefing error:", e);
    return c.json({ error: e.message || "internal error" }, 500);
  }
});

// POST /heartbeat — Agent pings periodically
bootRoutes.post("/heartbeat", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.agentName || !body.vmId) {
      return c.json({ error: "agentName and vmId are required" }, 400);
    }

    const result = heartbeat({
      agentName: body.agentName,
      vmId: body.vmId,
    });

    return c.json(result);
  } catch (e: any) {
    console.error("[boot] heartbeat error:", e);
    return c.json({ error: e.message || "internal error" }, 500);
  }
});

// POST /debrief — Agent calls before shutdown
bootRoutes.post("/debrief", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.agentName || !body.summary) {
      return c.json({ error: "agentName and summary are required" }, 400);
    }

    const result = debrief({
      agentName: body.agentName,
      summary: body.summary,
      artifacts: body.artifacts,
      commitId: body.commitId,
    });

    return c.json(result);
  } catch (e: any) {
    if (e.message?.includes("required")) {
      return c.json({ error: e.message }, 400);
    }
    console.error("[boot] debrief error:", e);
    return c.json({ error: e.message || "internal error" }, 500);
  }
});
