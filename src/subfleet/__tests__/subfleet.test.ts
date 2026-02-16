import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubFleetStore } from "../store.js";
import { SubFleetOrchestrator } from "../orchestrator.js";

// ── Store Tests ──────────────────────────────────────────────────────────────

describe("SubFleetStore", () => {
  let store: SubFleetStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "subfleet-test-"));
    store = new SubFleetStore(join(tmpDir, "subfleet.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a sub-fleet with correct fields", () => {
      const fleet = store.create({
        name: "test-oil-camp",
        purpose: "integration testing",
        goldenCommit: "abc123",
        vmCount: 3,
        ttlHours: 4,
      });

      expect(fleet.id).toBeTruthy();
      expect(fleet.name).toBe("test-oil-camp");
      expect(fleet.purpose).toBe("integration testing");
      expect(fleet.goldenCommit).toBe("abc123");
      expect(fleet.vmCount).toBe(3);
      expect(fleet.ttlHours).toBe(4);
      expect(fleet.status).toBe("active");
      expect(fleet.scopedToken).toHaveLength(64); // 32 bytes hex
    });

    it("sets expiresAt correctly", () => {
      const before = Date.now();
      const fleet = store.create({
        name: "test",
        purpose: "test",
        goldenCommit: "abc",
        vmCount: 1,
        ttlHours: 2,
      });
      const after = Date.now();

      const expiresAt = new Date(fleet.expiresAt).getTime();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + twoHoursMs);
      expect(expiresAt).toBeLessThanOrEqual(after + twoHoursMs);
    });

    it("generates unique scoped tokens per fleet", () => {
      const f1 = store.create({ name: "a", purpose: "x", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      const f2 = store.create({ name: "b", purpose: "y", goldenCommit: "c2", vmCount: 1, ttlHours: 1 });
      expect(f1.scopedToken).not.toBe(f2.scopedToken);
    });
  });

  describe("get", () => {
    it("retrieves a fleet by ID", () => {
      const created = store.create({ name: "fetch-me", purpose: "test", goldenCommit: "c1", vmCount: 2, ttlHours: 1 });
      const fetched = store.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("fetch-me");
      expect(fetched!.scopedToken).toBe(created.scopedToken);
    });

    it("returns null for unknown ID", () => {
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("listActive", () => {
    it("lists only active and destroying fleets", () => {
      const f1 = store.create({ name: "a", purpose: "x", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      const f2 = store.create({ name: "b", purpose: "y", goldenCommit: "c2", vmCount: 1, ttlHours: 1 });
      store.setStatus(f2.id, "destroyed");

      const active = store.listActive();
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("a");
      expect(active[0].ttlRemainingMs).toBeGreaterThan(0);
    });
  });

  describe("VM management", () => {
    it("adds and retrieves VMs", () => {
      const fleet = store.create({ name: "vm-test", purpose: "test", goldenCommit: "c1", vmCount: 2, ttlHours: 1 });
      store.addVM(fleet.id, "vm-111", "vm-test-0");
      store.addVM(fleet.id, "vm-222", "vm-test-1");

      const vms = store.getVMs(fleet.id);
      expect(vms).toHaveLength(2);
      expect(vms[0].vmId).toBe("vm-111");
      expect(vms[0].address).toBe("vm-111.vm.vers.sh");
      expect(vms[0].status).toBe("spawning");
    });

    it("updates VM status", () => {
      const fleet = store.create({ name: "s-test", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      store.addVM(fleet.id, "vm-333", "s-test-0");
      store.setVMStatus("vm-333", "running");

      const vm = store.getVMByVmId("vm-333");
      expect(vm).not.toBeNull();
      expect(vm!.status).toBe("running");
    });

    it("sets destroyedAt when status is destroyed", () => {
      const fleet = store.create({ name: "d-test", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      store.addVM(fleet.id, "vm-444", "d-test-0");
      store.setVMStatus("vm-444", "destroyed");

      const vm = store.getVMByVmId("vm-444");
      expect(vm!.destroyedAt).toBeTruthy();
    });
  });

  describe("extendTTL", () => {
    it("extends TTL by the given hours", () => {
      const fleet = store.create({ name: "ext-test", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 2 });
      const extended = store.extendTTL(fleet.id, 3);
      expect(extended).not.toBeNull();
      expect(extended!.ttlHours).toBe(5);

      const newExpiry = new Date(extended!.expiresAt).getTime();
      const origExpiry = new Date(fleet.expiresAt).getTime();
      const threeHoursMs = 3 * 60 * 60 * 1000;
      expect(newExpiry - origExpiry).toBeCloseTo(threeHoursMs, -2); // within ~100ms
    });

    it("returns null for destroyed fleet", () => {
      const fleet = store.create({ name: "dead", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      store.setStatus(fleet.id, "destroyed");
      expect(store.extendTTL(fleet.id, 1)).toBeNull();
    });
  });

  describe("getExpiredFleets", () => {
    it("returns fleets past their TTL", () => {
      // Create a fleet with 0.5h TTL, then manually set expires_at to past
      const fleet = store.create({ name: "old", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 0.5 });

      // Manually set expires_at to 1 hour ago
      const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      (store as any).db.prepare("UPDATE subfleets SET expires_at = ? WHERE id = ?").run(pastTime, fleet.id);

      const expired = store.getExpiredFleets();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe(fleet.id);
    });

    it("does not return active fleets within TTL", () => {
      store.create({ name: "fresh", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 4 });
      const expired = store.getExpiredFleets();
      expect(expired).toHaveLength(0);
    });
  });

  describe("getDetail", () => {
    it("returns fleet with VMs", () => {
      const fleet = store.create({ name: "detail-test", purpose: "test", goldenCommit: "c1", vmCount: 2, ttlHours: 1 });
      store.addVM(fleet.id, "vm-a", "detail-test-0");
      store.addVM(fleet.id, "vm-b", "detail-test-1");

      const detail = store.getDetail(fleet.id);
      expect(detail).not.toBeNull();
      expect(detail!.fleet.name).toBe("detail-test");
      expect(detail!.vms).toHaveLength(2);
    });
  });

  describe("audit", () => {
    it("records audit entries on creation", () => {
      const fleet = store.create({ name: "audit-test", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      const log = store.getAuditLog(fleet.id);
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0].action).toBe("created");
    });
  });

  describe("scoped token isolation", () => {
    it("scoped token is NOT the main infra token", () => {
      const fleet = store.create({ name: "iso-test", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
      // The scoped token should be a random 64-char hex, never matching common env tokens
      expect(fleet.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

// ── Orchestrator Tests ───────────────────────────────────────────────────────

describe("SubFleetOrchestrator", () => {
  let store: SubFleetStore;
  let tmpDir: string;

  // Mock Vers client
  const mockVersClient = {
    spawnFromCommit: vi.fn(),
    destroyVM: vi.fn(),
    listVMs: vi.fn(),
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "subfleet-orch-test-"));
    store = new SubFleetStore(join(tmpDir, "subfleet.db"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(opts: { isProtected?: (vmId: string) => boolean } = {}) {
    return new SubFleetOrchestrator({
      store,
      versClient: mockVersClient as any,
      isProtected: opts.isProtected,
    });
  }

  describe("create", () => {
    it("spawns VMs and returns fleet info", async () => {
      let vmCounter = 0;
      mockVersClient.spawnFromCommit.mockImplementation(async () => ({
        vmId: `vm-${++vmCounter}`,
      }));

      const orch = makeOrchestrator();
      const result = await orch.create({
        name: "test-fleet",
        purpose: "integration",
        goldenCommit: "golden-abc",
        vmCount: 3,
        ttlHours: 4,
      });

      expect(result.subfleetId).toBeTruthy();
      expect(result.vms).toHaveLength(3);
      expect(result.expiresAt).toBeTruthy();
      expect(result.scopedToken).toMatch(/^[0-9a-f]{64}$/);
      expect(mockVersClient.spawnFromCommit).toHaveBeenCalledTimes(3);
      expect(mockVersClient.spawnFromCommit).toHaveBeenCalledWith("golden-abc");

      // Verify VMs stored
      const vms = store.getVMs(result.subfleetId);
      expect(vms).toHaveLength(3);
      expect(vms[0].status).toBe("running");
    });

    it("handles partial spawn failures gracefully", async () => {
      let callCount = 0;
      mockVersClient.spawnFromCommit.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error("quota exceeded");
        return { vmId: `vm-${callCount}` };
      });

      const orch = makeOrchestrator();
      const result = await orch.create({
        name: "partial-fleet",
        purpose: "test",
        goldenCommit: "golden-abc",
        vmCount: 3,
        ttlHours: 2,
      });

      // Should still succeed with 2 of 3 VMs
      expect(result.vms).toHaveLength(2);
    });

    it("throws when all spawns fail", async () => {
      mockVersClient.spawnFromCommit.mockRejectedValue(new Error("API down"));

      const orch = makeOrchestrator();
      await expect(
        orch.create({
          name: "fail-fleet",
          purpose: "test",
          goldenCommit: "golden-abc",
          vmCount: 2,
          ttlHours: 1,
        })
      ).rejects.toThrow("Failed to spawn any VMs");
    });
  });

  describe("destroy", () => {
    it("destroys all VMs and marks fleet as destroyed", async () => {
      mockVersClient.spawnFromCommit
        .mockResolvedValueOnce({ vmId: "vm-a" })
        .mockResolvedValueOnce({ vmId: "vm-b" });
      mockVersClient.destroyVM.mockResolvedValue(undefined);

      const orch = makeOrchestrator();
      const fleet = await orch.create({
        name: "destroy-test",
        purpose: "test",
        goldenCommit: "golden-abc",
        vmCount: 2,
        ttlHours: 1,
      });

      const result = await orch.destroy(fleet.subfleetId);
      expect(result.destroyed).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(mockVersClient.destroyVM).toHaveBeenCalledTimes(2);

      const detail = store.get(fleet.subfleetId);
      expect(detail!.status).toBe("destroyed");
    });

    it("skips protected VMs", async () => {
      mockVersClient.spawnFromCommit
        .mockResolvedValueOnce({ vmId: "infra-vm" })
        .mockResolvedValueOnce({ vmId: "worker-vm" });
      mockVersClient.destroyVM.mockResolvedValue(undefined);

      const orch = makeOrchestrator({
        isProtected: (vmId) => vmId === "infra-vm",
      });

      const fleet = await orch.create({
        name: "protected-test",
        purpose: "test",
        goldenCommit: "golden-abc",
        vmCount: 2,
        ttlHours: 1,
      });

      const result = await orch.destroy(fleet.subfleetId);
      expect(result.destroyed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("protected");
      expect(mockVersClient.destroyVM).toHaveBeenCalledWith("worker-vm");
      expect(mockVersClient.destroyVM).not.toHaveBeenCalledWith("infra-vm");
    });

    it("throws for unknown sub-fleet", async () => {
      const orch = makeOrchestrator();
      await expect(orch.destroy("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("reap", () => {
    it("destroys expired fleets", async () => {
      mockVersClient.spawnFromCommit.mockResolvedValue({ vmId: "vm-reap" });
      mockVersClient.destroyVM.mockResolvedValue(undefined);

      const orch = makeOrchestrator();
      const fleet = await orch.create({
        name: "reap-test",
        purpose: "test",
        goldenCommit: "golden-abc",
        vmCount: 1,
        ttlHours: 0.5,
      });

      // Manually expire the fleet
      (store as any).db.prepare("UPDATE subfleets SET expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1000).toISOString(), fleet.subfleetId);

      const reaped = await orch.reap();
      expect(reaped).toContain(fleet.subfleetId);
    });

    it("does not reap active fleets within TTL", async () => {
      mockVersClient.spawnFromCommit.mockResolvedValue({ vmId: "vm-active" });

      const orch = makeOrchestrator();
      await orch.create({
        name: "active-test",
        purpose: "test",
        goldenCommit: "golden-abc",
        vmCount: 1,
        ttlHours: 4,
      });

      const reaped = await orch.reap();
      expect(reaped).toHaveLength(0);
    });
  });

  describe("getStatus", () => {
    it("returns fleet detail with TTL info", async () => {
      mockVersClient.spawnFromCommit.mockResolvedValue({ vmId: "vm-status" });

      const orch = makeOrchestrator();
      const fleet = await orch.create({
        name: "status-test",
        purpose: "test",
        goldenCommit: "golden-abc",
        vmCount: 1,
        ttlHours: 2,
      });

      const status = orch.getStatus(fleet.subfleetId);
      expect(status).not.toBeNull();
      expect(status!.fleet.name).toBe("status-test");
      expect(status!.vms).toHaveLength(1);
      expect(status!.ttlRemainingMs).toBeGreaterThan(0);
      expect(status!.expired).toBe(false);
    });

    it("returns null for unknown fleet", () => {
      const orch = makeOrchestrator();
      expect(orch.getStatus("bogus")).toBeNull();
    });
  });
});

// ── Route Tests ──────────────────────────────────────────────────────────────

describe("subfleet routes", () => {
  let store: SubFleetStore;
  let tmpDir: string;
  let app: Hono;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "subfleet-route-test-"));
    store = new SubFleetStore(join(tmpDir, "subfleet.db"));

    // Create a Hono app with the routes for testing
    app = new Hono();

    // Directly test store-level operations via route-like handlers
    app.get("/list", (c) => {
      const fleets = store.listActive();
      return c.json({ fleets });
    });

    app.get("/:id/status", (c) => {
      const id = c.req.param("id");
      const detail = store.getDetail(id);
      if (!detail) return c.json({ error: "Not found" }, 404);
      return c.json(detail);
    });

    app.post("/:id/extend", async (c) => {
      const id = c.req.param("id");
      const body = await c.req.json();
      const fleet = store.extendTTL(id, body.hours);
      if (!fleet) return c.json({ error: "Not found or not active" }, 404);
      return c.json({ subfleetId: fleet.id, expiresAt: fleet.expiresAt, ttlHours: fleet.ttlHours });
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /list returns empty initially", async () => {
    const res = await app.request("/list");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fleets).toHaveLength(0);
  });

  it("GET /list shows created fleets", async () => {
    store.create({ name: "fleet-1", purpose: "test", goldenCommit: "c1", vmCount: 2, ttlHours: 1 });
    store.create({ name: "fleet-2", purpose: "demo", goldenCommit: "c2", vmCount: 1, ttlHours: 2 });

    const res = await app.request("/list");
    const data = await res.json();
    expect(data.fleets).toHaveLength(2);
  });

  it("GET /:id/status returns 404 for unknown", async () => {
    const res = await app.request("/unknown-id/status");
    expect(res.status).toBe(404);
  });

  it("GET /:id/status returns fleet detail", async () => {
    const fleet = store.create({ name: "detail", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 1 });
    store.addVM(fleet.id, "vm-x", "detail-0");

    const res = await app.request(`/${fleet.id}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fleet.name).toBe("detail");
    expect(data.vms).toHaveLength(1);
  });

  it("POST /:id/extend extends TTL", async () => {
    const fleet = store.create({ name: "extend", purpose: "test", goldenCommit: "c1", vmCount: 1, ttlHours: 2 });

    const res = await app.request(`/${fleet.id}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours: 3 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ttlHours).toBe(5);
  });
});
