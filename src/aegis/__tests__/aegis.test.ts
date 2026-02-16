import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AegisStore } from "../store.js";
import { BudgetBreaker } from "../budget.js";
import { SpawnLimiter } from "../spawn.js";
import { ProtectedGuard } from "../protected.js";

// ── Store tests ──────────────────────────────────────────────────────────────

describe("AegisStore", () => {
  let store: AegisStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aegis-test-"));
    store = new AegisStore(join(tmpDir, "aegis.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("budget config", () => {
    it("seeds default budget config", () => {
      const cfg = store.getBudgetConfig();
      expect(cfg.maxTokensPerHour).toBe(2_000_000);
      expect(cfg.maxTokensPerDay).toBe(20_000_000);
      expect(cfg.maxCostPerDay).toBe(5000);
    });

    it("updates budget config", () => {
      const cfg = store.setBudgetConfig({ maxTokensPerHour: 500_000 });
      expect(cfg.maxTokensPerHour).toBe(500_000);
      expect(cfg.maxTokensPerDay).toBe(20_000_000); // unchanged
    });
  });

  describe("budget records", () => {
    it("records and sums token usage", () => {
      store.recordTokenUsage("agent-1", 1000, 10);
      store.recordTokenUsage("agent-1", 2000, 20);
      store.recordTokenUsage("agent-2", 500, 5);

      const HOUR = 60 * 60 * 1000;
      expect(store.getTokensInWindow("agent-1", HOUR)).toBe(3000);
      expect(store.getTokensInWindow("agent-2", HOUR)).toBe(500);
      expect(store.getTokensInWindow(null, HOUR)).toBe(3500);
    });

    it("getBudgetStatus shows blocked when over limit", () => {
      store.setBudgetConfig({ maxTokensPerHour: 100 });
      store.recordTokenUsage("agent-1", 150, 10);
      const status = store.getBudgetStatus("agent-1");
      expect(status.blocked).toBe(true);
      expect(status.reason).toContain("Hourly token limit");
    });

    it("getBudgetStatus shows not blocked when under limit", () => {
      store.recordTokenUsage("agent-1", 100, 1);
      const status = store.getBudgetStatus("agent-1");
      expect(status.blocked).toBe(false);
    });
  });

  describe("spawn config", () => {
    it("seeds default spawn config", () => {
      const cfg = store.getSpawnConfig();
      expect(cfg.maxConcurrentVMs).toBe(15);
      expect(cfg.maxSpawnsPerHour).toBe(30);
      expect(cfg.circuitBreakerThreshold).toBe(5);
    });
  });

  describe("spawn records", () => {
    it("tracks active VMs", () => {
      store.recordSpawn("vm-1", "agent-1", "spawn");
      store.recordSpawn("vm-2", "agent-1", "spawn");
      expect(store.getActiveVMCount()).toBe(2);

      store.recordSpawn("vm-1", "agent-1", "destroy");
      expect(store.getActiveVMCount()).toBe(1);
    });

    it("counts spawns in last hour", () => {
      store.recordSpawn("vm-1", "agent-1", "spawn");
      store.recordSpawn("vm-2", "agent-1", "spawn");
      expect(store.getSpawnsInLastHour()).toBe(2);
    });

    it("counts consecutive failures", () => {
      store.recordSpawn("vm-1", "agent-1", "spawn");
      store.recordSpawn("vm-2", "agent-1", "failure");
      store.recordSpawn("vm-3", "agent-1", "failure");
      store.recordSpawn("vm-4", "agent-1", "failure");
      expect(store.getConsecutiveFailures()).toBe(3);
    });

    it("resets consecutive failures on success", () => {
      store.recordSpawn("vm-1", "agent-1", "failure");
      store.recordSpawn("vm-2", "agent-1", "failure");
      store.recordSpawn("vm-3", "agent-1", "spawn");
      expect(store.getConsecutiveFailures()).toBe(0);
    });

    it("circuit breaker triggers", () => {
      store.setSpawnConfig({ circuitBreakerThreshold: 3 });
      store.recordSpawn("vm-1", "a", "failure");
      store.recordSpawn("vm-2", "a", "failure");
      store.recordSpawn("vm-3", "a", "failure");
      const status = store.getSpawnStatus();
      expect(status.circuitBreakerOpen).toBe(true);
    });

    it("canSpawn returns false when at VM limit", () => {
      store.setSpawnConfig({ maxConcurrentVMs: 2 });
      store.recordSpawn("vm-1", "a", "spawn");
      store.recordSpawn("vm-2", "a", "spawn");
      const check = store.canSpawn();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("Max concurrent VMs");
    });

    it("canSpawn returns false when hourly limit hit", () => {
      store.setSpawnConfig({ maxSpawnsPerHour: 2 });
      store.recordSpawn("vm-1", "a", "spawn");
      store.recordSpawn("vm-2", "a", "spawn");
      const check = store.canSpawn();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("Hourly spawn limit");
    });
  });

  describe("protected resources", () => {
    it("adds and lists protected resources", () => {
      store.addProtectedResource("vm-infra", "Infra VM", "Critical infrastructure", "noah");
      const list = store.getProtectedResources();
      expect(list).toHaveLength(1);
      expect(list[0].vmId).toBe("vm-infra");
    });

    it("checks if VM is protected", () => {
      store.addProtectedResource("vm-infra", "Infra VM", "Critical", "noah");
      expect(store.isProtected("vm-infra")).toBe(true);
      expect(store.isProtected("vm-other")).toBe(false);
    });

    it("removes protected resource", () => {
      const resource = store.addProtectedResource("vm-infra", "Infra VM", "Critical", "noah");
      expect(store.removeProtectedResource(resource.id)).toBe(true);
      expect(store.isProtected("vm-infra")).toBe(false);
    });

    it("returns false for removing non-existent resource", () => {
      expect(store.removeProtectedResource("nonexistent")).toBe(false);
    });

    it("prevents duplicate VM protection", () => {
      store.addProtectedResource("vm-infra", "Infra VM", "Critical", "noah");
      expect(() =>
        store.addProtectedResource("vm-infra", "Infra VM 2", "Also critical", "noah")
      ).toThrow();
    });
  });

  describe("audit log", () => {
    it("records and retrieves audit entries", () => {
      store.audit("budget", "test_action", "test detail");
      const entries = store.getAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("budget");
      expect(entries[0].action).toBe("test_action");
    });
  });
});

// ── BudgetBreaker tests ──────────────────────────────────────────────────────

describe("BudgetBreaker", () => {
  let store: AegisStore;
  let budget: BudgetBreaker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aegis-budget-test-"));
    store = new AegisStore(join(tmpDir, "aegis.db"));
    budget = new BudgetBreaker(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records usage and checks budget", () => {
    const result = budget.record("agent-1", 1000, 10);
    expect(result.allowed).toBe(true);
    expect(result.status.tokensThisHour).toBe(1000);
  });

  it("blocks when over budget", () => {
    budget.setConfig({ maxTokensPerHour: 100 });
    const result = budget.record("agent-1", 200, 10);
    expect(result.allowed).toBe(false);
  });

  it("pre-flight check works", () => {
    const result = budget.check("agent-1");
    expect(result.allowed).toBe(true);
  });
});

// ── SpawnLimiter tests ───────────────────────────────────────────────────────

describe("SpawnLimiter", () => {
  let store: AegisStore;
  let spawner: SpawnLimiter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aegis-spawn-test-"));
    store = new AegisStore(join(tmpDir, "aegis.db"));
    spawner = new SpawnLimiter(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows spawn when under limits", () => {
    const check = spawner.canSpawn();
    expect(check.allowed).toBe(true);
  });

  it("records spawn and updates status", () => {
    const result = spawner.recordSpawn("vm-1", "agent-1");
    expect(result.status.activeVMs).toBe(1);
  });

  it("circuit breaker trips after consecutive failures", () => {
    spawner.setConfig({ circuitBreakerThreshold: 2 });
    spawner.recordFailure("vm-1", "a");
    const result = spawner.recordFailure("vm-2", "a");
    expect(result.status.circuitBreakerOpen).toBe(true);
  });

  it("circuit breaker resets", () => {
    spawner.setConfig({ circuitBreakerThreshold: 2 });
    spawner.recordFailure("vm-1", "a");
    spawner.recordFailure("vm-2", "a");
    const status = spawner.resetCircuitBreaker();
    expect(status.circuitBreakerOpen).toBe(false);
  });
});

// ── ProtectedGuard tests ─────────────────────────────────────────────────────

describe("ProtectedGuard", () => {
  let store: AegisStore;
  let guard: ProtectedGuard;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aegis-prot-test-"));
    store = new AegisStore(join(tmpDir, "aegis.db"));
    guard = new ProtectedGuard(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks deletion of protected VMs", () => {
    guard.add("vm-infra", "Infra", "Critical", "noah");
    const check = guard.canDelete("vm-infra");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("protected");
  });

  it("allows deletion of unprotected VMs", () => {
    const check = guard.canDelete("vm-random");
    expect(check.allowed).toBe(true);
  });

  it("lists protected resources", () => {
    guard.add("vm-1", "Infra", "Critical", "noah");
    guard.add("vm-2", "Gitea", "Source code", "noah");
    expect(guard.list()).toHaveLength(2);
  });

  it("removes protection", () => {
    const resource = guard.add("vm-1", "Test", "Testing", "noah");
    guard.remove(resource.id);
    expect(guard.isProtected("vm-1")).toBe(false);
  });
});

// ── Route integration tests ──────────────────────────────────────────────────

describe("Aegis Routes", () => {
  let store: AegisStore;
  let tmpDir: string;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "aegis-routes-test-"));
    store = new AegisStore(join(tmpDir, "aegis.db"));
    const budget = new BudgetBreaker(store);
    const spawner = new SpawnLimiter(store);
    const guard = new ProtectedGuard(store);

    // Build a test app with fresh instances
    app = new Hono();

    // Budget routes
    app.get("/budget", (c) => c.json({ config: budget.getConfig() }));
    app.get("/budget/status", (c) => {
      const agentId = c.req.query("agent");
      return c.json({ status: agentId ? budget.agentStatus(agentId) : budget.globalStatus() });
    });
    app.post("/budget/config", async (c) => {
      const body = await c.req.json();
      const config = budget.setConfig(body);
      return c.json({ config });
    });
    app.post("/budget/record", async (c) => {
      const body = await c.req.json();
      const result = budget.record(body.agentId, body.tokens, body.costCents ?? 0);
      return c.json(result);
    });

    // Spawn routes
    app.get("/spawn/status", (c) => c.json({ status: spawner.getStatus() }));
    app.post("/spawn/config", async (c) => {
      const body = await c.req.json();
      const config = spawner.setConfig(body);
      return c.json({ config });
    });

    // Protected routes
    app.get("/protected", (c) => c.json({ resources: guard.list() }));
    app.post("/protected", async (c) => {
      const body = await c.req.json();
      const resource = guard.add(body.vmId, body.label, body.reason ?? "", body.addedBy ?? "test");
      return c.json(resource, 201);
    });
    app.delete("/protected/:id", (c) => {
      const removed = guard.remove(c.req.param("id"));
      return removed ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
    });
    app.post("/protected/check", async (c) => {
      const body = await c.req.json();
      return c.json(guard.canDelete(body.vmId));
    });

    // Audit
    app.get("/audit", (c) => c.json({ entries: store.getAuditLog() }));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /budget returns config", async () => {
    const res = await app.request("/budget");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config.maxTokensPerHour).toBe(2_000_000);
  });

  it("POST /budget/config updates limits", async () => {
    const res = await app.request("/budget/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTokensPerHour: 100_000 }),
    });
    const data = await res.json();
    expect(data.config.maxTokensPerHour).toBe(100_000);
  });

  it("GET /budget/status returns status", async () => {
    const res = await app.request("/budget/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status.blocked).toBe(false);
  });

  it("POST /budget/record tracks usage", async () => {
    const res = await app.request("/budget/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "test-agent", tokens: 5000, costCents: 50 }),
    });
    const data = await res.json();
    expect(data.allowed).toBe(true);
    expect(data.status.tokensThisHour).toBe(5000);
  });

  it("GET /spawn/status returns spawn status", async () => {
    const res = await app.request("/spawn/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status.config.maxConcurrentVMs).toBe(15);
  });

  it("GET /protected returns empty list initially", async () => {
    const res = await app.request("/protected");
    const data = await res.json();
    expect(data.resources).toHaveLength(0);
  });

  it("POST /protected adds a resource", async () => {
    const res = await app.request("/protected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: "vm-infra", label: "Infra VM", reason: "Critical" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.vmId).toBe("vm-infra");
  });

  it("DELETE /protected/:id removes resource", async () => {
    const addRes = await app.request("/protected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: "vm-test", label: "Test" }),
    });
    const resource = await addRes.json();

    const delRes = await app.request(`/protected/${resource.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
  });

  it("POST /protected/check blocks protected VM deletion", async () => {
    await app.request("/protected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: "vm-infra", label: "Infra" }),
    });

    const res = await app.request("/protected/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: "vm-infra" }),
    });
    const data = await res.json();
    expect(data.allowed).toBe(false);
  });

  it("GET /audit returns audit log", async () => {
    // Trigger an auditable action
    await app.request("/budget/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTokensPerHour: 999 }),
    });

    const res = await app.request("/audit");
    const data = await res.json();
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries[0].service).toBe("budget");
  });
});
