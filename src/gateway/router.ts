/**
 * Gateway Router — reverse proxy for microservices backend.
 *
 * Routes requests to core-api (:3001), fleet-api (:3002), autonomy-api (:3003)
 * using plain fetch() forwarding. Adds request tracing, concurrency limiting,
 * timeouts, and health aggregation.
 */

import { ulid } from "ulid";

// ── Route Table ──────────────────────────────────────────────────────────────

export interface BackendConfig {
  url: string;
  name: string;
  healthPath?: string;
}

export const BACKENDS: Record<string, BackendConfig> = {
  "core-api": { url: "http://localhost:3001", name: "core-api", healthPath: "/health" },
  "fleet-api": { url: "http://localhost:3002", name: "fleet-api", healthPath: "/health" },
  "autonomy-api": { url: "http://localhost:3003", name: "autonomy-api", healthPath: "/health" },
};

/** Maps path prefixes → backend names. Order matters: first match wins. */
export const ROUTE_TABLE: Array<[string, string]> = [
  // Core API (port 3001)
  ["/board", "core-api"],
  ["/feed", "core-api"],
  ["/log", "core-api"],
  ["/reports", "core-api"],
  ["/kb", "core-api"],
  ["/journal", "core-api"],
  ["/skills", "core-api"],
  ["/personas", "core-api"],
  ["/cryo", "core-api"],
  ["/commits", "core-api"],
  ["/config", "core-api"],
  ["/notifications", "core-api"],
  ["/usage", "core-api"],
  ["/events", "core-api"],
  ["/review", "core-api"],
  ["/watchdog", "core-api"],
  ["/chat", "core-api"],
  ["/auth", "core-api"],
  ["/v1", "core-api"],
  ["/router", "core-api"],
  ["/docs", "core-api"],
  ["/blog", "core-api"],

  // Fleet API (port 3002)
  ["/fleet-chat", "fleet-api"],
  ["/contacts", "fleet-api"],
  ["/couch", "fleet-api"],
  ["/gossip", "fleet-api"],
  ["/registry", "fleet-api"],
  ["/twilio", "fleet-api"],

  // Autonomy API (port 3003)
  ["/aegis", "autonomy-api"],
  ["/daemon", "autonomy-api"],
  ["/deploy", "autonomy-api"],
  ["/loop", "autonomy-api"],
  ["/webhooks", "autonomy-api"],
];

// ── Concurrency Limiter ──────────────────────────────────────────────────────

interface PendingRequest {
  resolve: () => void;
}

export class ConcurrencyLimiter {
  private active: Map<string, number> = new Map();
  private queues: Map<string, PendingRequest[]> = new Map();

  constructor(private maxConcurrent: number = 10) {}

  async acquire(backend: string): Promise<void> {
    const current = this.active.get(backend) || 0;
    if (current < this.maxConcurrent) {
      this.active.set(backend, current + 1);
      return;
    }
    // Queue the request
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(backend) || [];
      queue.push({ resolve });
      this.queues.set(backend, queue);
    });
  }

  release(backend: string): void {
    const queue = this.queues.get(backend) || [];
    if (queue.length > 0) {
      const next = queue.shift()!;
      next.resolve();
      return;
    }
    const current = this.active.get(backend) || 1;
    this.active.set(backend, Math.max(0, current - 1));
  }

  getStats(): Record<string, { active: number; queued: number }> {
    const stats: Record<string, { active: number; queued: number }> = {};
    for (const [name] of Object.entries(BACKENDS)) {
      stats[name] = {
        active: this.active.get(name) || 0,
        queued: (this.queues.get(name) || []).length,
      };
    }
    return stats;
  }
}

// ── Health Checker ───────────────────────────────────────────────────────────

export interface BackendHealth {
  name: string;
  status: "healthy" | "unhealthy" | "unknown";
  lastCheck: string | null;
  latencyMs: number | null;
}

export class HealthChecker {
  private health: Map<string, BackendHealth> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private checkIntervalMs: number = 10_000) {
    for (const [name, config] of Object.entries(BACKENDS)) {
      this.health.set(name, {
        name: config.name,
        status: "unknown",
        lastCheck: null,
        latencyMs: null,
      });
    }
  }

  start(): void {
    this.checkAll();
    this.interval = setInterval(() => this.checkAll(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  isHealthy(backend: string): boolean {
    const h = this.health.get(backend);
    return h?.status === "healthy";
  }

  getAll(): BackendHealth[] {
    return Array.from(this.health.values());
  }

  private async checkAll(): Promise<void> {
    const checks = Object.entries(BACKENDS).map(([name, config]) =>
      this.checkOne(name, config)
    );
    await Promise.allSettled(checks);
  }

  private async checkOne(name: string, config: BackendConfig): Promise<void> {
    const start = Date.now();
    try {
      const resp = await fetch(`${config.url}${config.healthPath || "/health"}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const latencyMs = Date.now() - start;
      this.health.set(name, {
        name: config.name,
        status: resp.ok ? "healthy" : "unhealthy",
        lastCheck: new Date().toISOString(),
        latencyMs,
      });
    } catch {
      this.health.set(name, {
        name: config.name,
        status: "unhealthy",
        lastCheck: new Date().toISOString(),
        latencyMs: null,
      });
    }
  }
}

// ── Request Forwarder ────────────────────────────────────────────────────────

export interface ForwardResult {
  response: Response;
  backend: string;
  latencyMs: number;
}

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve the backend for a given path.
 * Returns null if no route matches (gateway should handle itself).
 */
export function resolveBackend(path: string): string | null {
  for (const [prefix, backend] of ROUTE_TABLE) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      return backend;
    }
  }
  return null;
}

/**
 * Forward a request to the appropriate backend service.
 */
export async function forwardRequest(
  req: Request,
  backend: string,
  limiter: ConcurrencyLimiter,
): Promise<ForwardResult> {
  const config = BACKENDS[backend];
  if (!config) {
    throw new Error(`Unknown backend: ${backend}`);
  }

  await limiter.acquire(backend);
  const start = Date.now();

  try {
    const url = new URL(req.url);
    const targetUrl = `${config.url}${url.pathname}${url.search}`;

    // Build headers — forward all except hop-by-hop
    const headers = new Headers(req.headers);
    headers.set("X-Request-Id", ulid());
    headers.set("X-Forwarded-For", headers.get("x-forwarded-for") || "gateway");
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    // Remove hop-by-hop headers
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("transfer-encoding");

    const init: RequestInit = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    // Forward body for methods that have one
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      // @ts-expect-error - duplex is needed for streaming request bodies in Node
      init.duplex = "half";
    }

    const response = await fetch(targetUrl, init);
    return {
      response,
      backend,
      latencyMs: Date.now() - start,
    };
  } finally {
    limiter.release(backend);
  }
}
