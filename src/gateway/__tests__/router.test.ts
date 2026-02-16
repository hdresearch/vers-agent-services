import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveBackend,
  ConcurrencyLimiter,
  HealthChecker,
  ROUTE_TABLE,
  BACKENDS,
} from "../router.js";

// ── resolveBackend ───────────────────────────────────────────────────────────

describe("resolveBackend", () => {
  it("routes /board to core-api", () => {
    expect(resolveBackend("/board")).toBe("core-api");
    expect(resolveBackend("/board/tasks")).toBe("core-api");
    expect(resolveBackend("/board/tasks/123/notes")).toBe("core-api");
  });

  it("routes /feed to core-api", () => {
    expect(resolveBackend("/feed")).toBe("core-api");
    expect(resolveBackend("/feed/events")).toBe("core-api");
    expect(resolveBackend("/feed/stream")).toBe("core-api");
  });

  it("routes /log to core-api", () => {
    expect(resolveBackend("/log")).toBe("core-api");
  });

  it("routes /reports to core-api", () => {
    expect(resolveBackend("/reports")).toBe("core-api");
    expect(resolveBackend("/reports/share/abc")).toBe("core-api");
  });

  it("routes /kb to core-api", () => {
    expect(resolveBackend("/kb")).toBe("core-api");
    expect(resolveBackend("/kb/entries")).toBe("core-api");
  });

  it("routes /v1 (LLM router) to core-api", () => {
    expect(resolveBackend("/v1")).toBe("core-api");
    expect(resolveBackend("/v1/chat/completions")).toBe("core-api");
  });

  it("routes fleet services to fleet-api", () => {
    expect(resolveBackend("/fleet-chat")).toBe("fleet-api");
    expect(resolveBackend("/fleet-chat/inbox")).toBe("fleet-api");
    expect(resolveBackend("/contacts")).toBe("fleet-api");
    expect(resolveBackend("/contacts/peer/accept")).toBe("fleet-api");
    expect(resolveBackend("/couch")).toBe("fleet-api");
    expect(resolveBackend("/gossip")).toBe("fleet-api");
    expect(resolveBackend("/registry")).toBe("fleet-api");
    expect(resolveBackend("/registry/vms")).toBe("fleet-api");
    expect(resolveBackend("/twilio")).toBe("fleet-api");
  });

  it("routes autonomy services to autonomy-api", () => {
    expect(resolveBackend("/aegis")).toBe("autonomy-api");
    expect(resolveBackend("/aegis/budget")).toBe("autonomy-api");
    expect(resolveBackend("/daemon")).toBe("autonomy-api");
    expect(resolveBackend("/daemon/status")).toBe("autonomy-api");
    expect(resolveBackend("/deploy")).toBe("autonomy-api");
    expect(resolveBackend("/deploy/trigger")).toBe("autonomy-api");
    expect(resolveBackend("/loop")).toBe("autonomy-api");
    expect(resolveBackend("/webhooks")).toBe("autonomy-api");
  });

  it("returns null for unknown paths", () => {
    expect(resolveBackend("/")).toBeNull();
    expect(resolveBackend("/unknown")).toBeNull();
    expect(resolveBackend("/ui")).toBeNull();
    expect(resolveBackend("/favicon.ico")).toBeNull();
  });

  it("does not match partial prefixes", () => {
    // /boardroom should NOT match /board
    expect(resolveBackend("/boardroom")).toBeNull();
    // /feedback should NOT match /feed
    expect(resolveBackend("/feedback")).toBeNull();
  });

  it("covers all route table entries", () => {
    for (const [prefix, backend] of ROUTE_TABLE) {
      const result = resolveBackend(prefix);
      expect(result).toBe(backend);
      // Also test with a sub-path
      const subResult = resolveBackend(`${prefix}/sub`);
      expect(subResult).toBe(backend);
    }
  });
});

// ── ConcurrencyLimiter ───────────────────────────────────────────────────────

describe("ConcurrencyLimiter", () => {
  let limiter: ConcurrencyLimiter;

  beforeEach(() => {
    limiter = new ConcurrencyLimiter(3);
  });

  it("allows requests up to max concurrency", async () => {
    await limiter.acquire("core-api");
    await limiter.acquire("core-api");
    await limiter.acquire("core-api");
    const stats = limiter.getStats();
    expect(stats["core-api"].active).toBe(3);
    expect(stats["core-api"].queued).toBe(0);
  });

  it("queues requests beyond max concurrency", async () => {
    await limiter.acquire("core-api");
    await limiter.acquire("core-api");
    await limiter.acquire("core-api");

    // This should queue
    let resolved = false;
    const p = limiter.acquire("core-api").then(() => {
      resolved = true;
    });

    // Give it a tick to process
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    const stats = limiter.getStats();
    expect(stats["core-api"].queued).toBe(1);

    // Release one — the queued request should proceed
    limiter.release("core-api");
    await p;
    expect(resolved).toBe(true);
  });

  it("tracks separate backends independently", async () => {
    await limiter.acquire("core-api");
    await limiter.acquire("core-api");
    await limiter.acquire("fleet-api");

    const stats = limiter.getStats();
    expect(stats["core-api"].active).toBe(2);
    expect(stats["fleet-api"].active).toBe(1);
  });

  it("release decrements active count", async () => {
    await limiter.acquire("core-api");
    await limiter.acquire("core-api");
    limiter.release("core-api");

    const stats = limiter.getStats();
    expect(stats["core-api"].active).toBe(1);
  });

  it("release does not go below zero", () => {
    limiter.release("core-api");
    const stats = limiter.getStats();
    expect(stats["core-api"].active).toBe(0);
  });
});

// ── HealthChecker ────────────────────────────────────────────────────────────

describe("HealthChecker", () => {
  it("starts with all backends unknown", () => {
    const checker = new HealthChecker(60_000);
    const all = checker.getAll();
    expect(all.length).toBe(Object.keys(BACKENDS).length);
    for (const h of all) {
      expect(h.status).toBe("unknown");
      expect(h.lastCheck).toBeNull();
    }
  });

  it("isHealthy returns false for unknown backends", () => {
    const checker = new HealthChecker(60_000);
    expect(checker.isHealthy("core-api")).toBe(false);
    expect(checker.isHealthy("fleet-api")).toBe(false);
    expect(checker.isHealthy("nonexistent")).toBe(false);
  });

  it("stop clears interval without error", () => {
    const checker = new HealthChecker(60_000);
    checker.stop(); // should not throw even if not started
    checker.start();
    checker.stop();
  });
});

// ── BACKENDS config ──────────────────────────────────────────────────────────

describe("BACKENDS", () => {
  it("has all three backends configured", () => {
    expect(BACKENDS["core-api"]).toBeDefined();
    expect(BACKENDS["fleet-api"]).toBeDefined();
    expect(BACKENDS["autonomy-api"]).toBeDefined();
  });

  it("each backend has url, name, and healthPath", () => {
    for (const [key, config] of Object.entries(BACKENDS)) {
      expect(config.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(config.name).toBe(key);
      expect(config.healthPath).toBe("/health");
    }
  });

  it("backends listen on different ports", () => {
    const ports = Object.values(BACKENDS).map((b) => new URL(b.url).port);
    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(ports.length);
  });
});
