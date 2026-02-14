import { Hono } from "hono";
import { RouterStore } from "./store.js";
import { ConfigStore } from "../config/store.js";
import { proxyChatCompletion, proxyAnthropicMessages } from "./proxy.js";
import type { ProviderConfig } from "./store.js";

export const routerStore = new RouterStore();
const configStore = new ConfigStore();

export const routerRoutes = new Hono();

// --- In-memory per-agent rate limiting ---
const agentBuckets = new Map<string, number[]>();

function checkAgentRateLimit(agent: string): { allowed: boolean; retryAfter?: number } {
  const config = routerStore.getRateLimit(agent);
  const now = Date.now();
  const windowMs = 60_000;

  let timestamps = agentBuckets.get(agent) || [];
  timestamps = timestamps.filter((ts) => now - ts < windowMs);

  if (timestamps.length >= config.requestsPerMinute) {
    const oldest = timestamps[0];
    const retryAfter = Math.ceil((windowMs - (now - oldest)) / 1000);
    agentBuckets.set(agent, timestamps);
    return { allowed: false, retryAfter };
  }

  timestamps.push(now);
  agentBuckets.set(agent, timestamps);
  return { allowed: true };
}

// Cleanup stale buckets periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of agentBuckets) {
    const filtered = timestamps.filter((ts) => now - ts < 120_000);
    if (filtered.length === 0) agentBuckets.delete(key);
    else agentBuckets.set(key, filtered);
  }
}, 60_000);
if (cleanupInterval.unref) cleanupInterval.unref();

// --- Auth: extract agent identity ---
function extractAgent(authHeader: string | undefined): string {
  // Agent identifies itself via x-agent-id header or we extract from bearer token
  return "fleet-agent";
}

// --- Health Check ---
routerRoutes.get("/health", (c) => {
  const providers = routerStore.getAllProviders();
  const providerStatus: Record<string, { configured: boolean; keySet: boolean }> = {};

  for (const provider of providers) {
    const entry = configStore.get(provider.apiKeyConfigKey);
    const keyFromEnv = process.env[provider.apiKeyConfigKey];
    const hasKey = !!(entry?.value || keyFromEnv);

    providerStatus[provider.name] = {
      configured: true,
      keySet: hasKey,
    };
  }

  const allKeysSet = Object.values(providerStatus).every((p) => p.keySet);

  return c.json({
    status: allKeysSet ? "ok" : "degraded",
    uptime: process.uptime(),
    providers: providerStatus,
  });
});

// --- OpenAI-compatible: POST /v1/chat/completions ---
routerRoutes.post("/chat/completions", async (c) => {
  const startMs = Date.now();
  const agent = c.req.header("x-agent-id") || extractAgent(c.req.header("Authorization"));

  // Rate limit check
  const rateCheck = checkAgentRateLimit(agent);
  if (!rateCheck.allowed) {
    return c.json(
      { error: { message: "Rate limit exceeded", type: "rate_limit_error" } },
      429,
      { "Retry-After": String(rateCheck.retryAfter) }
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  if (!body.model) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }

  // Resolve provider
  const provider = routerStore.resolveProvider(body.model);
  if (!provider) {
    return c.json({
      error: {
        message: `No provider configured for model: ${body.model}`,
        type: "invalid_request_error",
      },
    }, 400);
  }

  try {
    const result = await proxyChatCompletion(provider, configStore, body, c.req.raw.headers);

    // Log the request (async, don't block response)
    const latencyMs = Date.now() - startMs;
    try {
      routerStore.logRequest({
        agent,
        model: body.model,
        provider: provider.name,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        latencyMs,
        status: result.response.status,
      });
    } catch {
      // Don't fail the request if logging fails
    }

    // Pass through the response (streaming or not)
    return new Response(result.response.body, {
      status: result.response.status,
      headers: result.response.headers,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    try {
      routerStore.logRequest({
        agent,
        model: body.model,
        provider: provider.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs,
        status: 502,
      });
    } catch {
      // ignore
    }

    return c.json({
      error: {
        message: `Upstream error: ${err.message}`,
        type: "upstream_error",
      },
    }, 502);
  }
});

// --- Anthropic-native: POST /v1/messages ---
routerRoutes.post("/messages", async (c) => {
  const startMs = Date.now();
  const agent = c.req.header("x-agent-id") || extractAgent(c.req.header("Authorization"));

  // Rate limit check
  const rateCheck = checkAgentRateLimit(agent);
  if (!rateCheck.allowed) {
    return c.json(
      { error: { message: "Rate limit exceeded", type: "rate_limit_error" } },
      429,
      { "Retry-After": String(rateCheck.retryAfter) }
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  if (!body.model) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }

  // For /v1/messages, always route to Anthropic
  const provider = routerStore.resolveProvider(body.model) ||
    routerStore.getProvider("anthropic");

  if (!provider) {
    return c.json({
      error: {
        message: `No provider configured for model: ${body.model}`,
        type: "invalid_request_error",
      },
    }, 400);
  }

  try {
    const result = await proxyAnthropicMessages(provider, configStore, body, c.req.raw.headers);

    const latencyMs = Date.now() - startMs;
    try {
      routerStore.logRequest({
        agent,
        model: body.model,
        provider: provider.name,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        latencyMs,
        status: result.response.status,
      });
    } catch {
      // Don't fail the request if logging fails
    }

    return new Response(result.response.body, {
      status: result.response.status,
      headers: result.response.headers,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    try {
      routerStore.logRequest({
        agent,
        model: body.model,
        provider: provider.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs,
        status: 502,
      });
    } catch {
      // ignore
    }

    return c.json({
      error: {
        message: `Upstream error: ${err.message}`,
        type: "upstream_error",
      },
    }, 502);
  }
});

// --- Admin: provider management ---
routerRoutes.get("/providers", (c) => {
  const providers = routerStore.getAllProviders();
  return c.json({ providers });
});

routerRoutes.put("/providers/:name", async (c) => {
  try {
    const name = c.req.param("name");
    const body = await c.req.json();
    routerStore.setProvider({ name, ...body });
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// --- Admin: rate limit management ---
routerRoutes.get("/rate-limits/:agent", (c) => {
  const agent = c.req.param("agent");
  return c.json(routerStore.getRateLimit(agent));
});

routerRoutes.put("/rate-limits/:agent", async (c) => {
  const agent = c.req.param("agent");
  const body = await c.req.json();
  routerStore.setRateLimit({ agent, ...body });
  return c.json({ ok: true });
});

// --- Admin: request stats ---
routerRoutes.get("/stats", (c) => {
  const range = c.req.query("range") || "1h";
  return c.json(routerStore.getRequestStats(range));
});
