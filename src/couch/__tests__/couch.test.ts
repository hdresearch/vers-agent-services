import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CouchStore,
  NotFoundError,
  ValidationError,
  ConflictError,
} from "../store.js";

// ---------------------------------------------------------------------------
// Store Unit Tests
// ---------------------------------------------------------------------------

describe("CouchStore", () => {
  let store: CouchStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "couch-test-"));
    store = new CouchStore(join(tmpDir, "couch.json"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Invite tests ---------------------------------------------------------

  describe("createInvite", () => {
    it("creates an invite with defaults", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      expect(inv.id).toBeTruthy();
      expect(inv.code).toMatch(/^inv_/);
      expect(inv.status).toBe("active");
      expect(inv.resourceLimits.maxCpuCores).toBe(2);
      expect(inv.resourceLimits.maxMemoryMB).toBe(4096);
      expect(inv.resourceLimits.maxDiskGB).toBe(20);
      expect(inv.resourceLimits.maxTokenBudget).toBe(50_000_000);
      expect(inv.permissions.canAccessInternet).toBe(true);
      expect(inv.permissions.canSpawnSubAgents).toBe(false);
      expect(inv.permissions.canAccessHostServices).toBe(false);
      expect(inv.createdBy).toBe("noah");
    });

    it("creates an invite with custom limits", () => {
      const inv = store.createInvite({
        createdBy: "noah",
        label: "for ty",
        resourceLimits: { maxCpuCores: 4, maxMemoryMB: 8192 },
        permissions: { canSpawnSubAgents: true },
        expiresInHours: 48,
      });
      expect(inv.label).toBe("for ty");
      expect(inv.resourceLimits.maxCpuCores).toBe(4);
      expect(inv.resourceLimits.maxMemoryMB).toBe(8192);
      // Other defaults preserved
      expect(inv.resourceLimits.maxDiskGB).toBe(20);
      expect(inv.permissions.canSpawnSubAgents).toBe(true);
      expect(inv.permissions.canAccessInternet).toBe(true);
    });

    it("rejects missing createdBy", () => {
      expect(() => store.createInvite({ createdBy: "" })).toThrow(ValidationError);
    });

    it("rejects invalid expiresInHours", () => {
      expect(() => store.createInvite({ createdBy: "noah", expiresInHours: 0 })).toThrow(ValidationError);
      expect(() => store.createInvite({ createdBy: "noah", expiresInHours: 800 })).toThrow(ValidationError);
    });

    it("rejects maxDurationHours over 720", () => {
      expect(() =>
        store.createInvite({ createdBy: "noah", resourceLimits: { maxDurationHours: 1000 } as any }),
      ).toThrow(ValidationError);
    });
  });

  describe("listInvites", () => {
    it("lists and filters invites", () => {
      store.createInvite({ createdBy: "noah" });
      store.createInvite({ createdBy: "noah" });

      expect(store.listInvites()).toHaveLength(2);
      expect(store.listInvites("active")).toHaveLength(2);
      expect(store.listInvites("redeemed")).toHaveLength(0);
    });
  });

  describe("revokeInvite", () => {
    it("revokes an active invite", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const revoked = store.revokeInvite(inv.id);
      expect(revoked.status).toBe("revoked");
      // Can no longer find by code
      expect(store.getInviteByCode(inv.code)).toBeUndefined();
    });

    it("cannot revoke a non-active invite", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      store.revokeInvite(inv.id);
      expect(() => store.revokeInvite(inv.id)).toThrow(ValidationError);
    });

    it("throws NotFoundError for missing invite", () => {
      expect(() => store.revokeInvite("nonexistent")).toThrow(NotFoundError);
    });
  });

  // -- Redeem tests ---------------------------------------------------------

  describe("redeemInvite", () => {
    it("redeems a valid invite and creates a guest", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });

      expect(guest.id).toBeTruthy();
      expect(guest.name).toBe("ty");
      expect(guest.status).toBe("provisioning");
      expect(guest.authToken).toMatch(/^guest_/);
      expect(guest.inviteId).toBe(inv.id);
      expect(guest.resourceLimits.maxCpuCores).toBe(2);

      // Invite is now redeemed
      const updated = store.getInvite(inv.id);
      expect(updated?.status).toBe("redeemed");
      expect(updated?.guestId).toBe(guest.id);
    });

    it("single-use: cannot redeem twice", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      store.redeemInvite({ code: inv.code, name: "ty" });
      expect(() => store.redeemInvite({ code: inv.code, name: "other" })).toThrow();
    });

    it("cannot redeem revoked invite", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      store.revokeInvite(inv.id);
      expect(() => store.redeemInvite({ code: inv.code, name: "ty" })).toThrow();
    });

    it("rejects missing code", () => {
      expect(() => store.redeemInvite({ code: "", name: "ty" })).toThrow(ValidationError);
    });

    it("rejects missing name", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      expect(() => store.redeemInvite({ code: inv.code, name: "" })).toThrow(ValidationError);
    });

    it("stores publicKey when provided", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({
        code: inv.code,
        name: "ty",
        publicKey: "ssh-ed25519 AAAA...",
      });
      expect(guest.publicKey).toBe("ssh-ed25519 AAAA...");
    });
  });

  // -- Guest management tests -----------------------------------------------

  describe("guest lifecycle", () => {
    it("activates a provisioning guest", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      const active = store.activateGuest(guest.id, "vm-123", "https://vm-123.vers.sh");

      expect(active.status).toBe("running");
      expect(active.vmId).toBe("vm-123");
      expect(active.agentEndpoint).toBe("https://vm-123.vers.sh");
    });

    it("cannot activate a non-provisioning guest", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      store.activateGuest(guest.id, "vm-123", "https://vm-123.vers.sh");
      expect(() => store.activateGuest(guest.id, "vm-456", "https://vm-456.vers.sh")).toThrow(
        ValidationError,
      );
    });

    it("kills a running guest", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      store.activateGuest(guest.id, "vm-123", "https://vm-123.vers.sh");

      const killed = store.killGuest(guest.id);
      expect(killed.status).toBe("revoked");
      expect(killed.stoppedAt).toBeTruthy();
    });

    it("cannot kill an already stopped guest", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      store.activateGuest(guest.id, "vm-123", "https://vm-123.vers.sh");
      store.killGuest(guest.id);
      expect(() => store.killGuest(guest.id)).toThrow(ValidationError);
    });

    it("lists guests with status filter", () => {
      const inv1 = store.createInvite({ createdBy: "noah" });
      const inv2 = store.createInvite({ createdBy: "noah" });
      const g1 = store.redeemInvite({ code: inv1.code, name: "ty" });
      store.redeemInvite({ code: inv2.code, name: "alex" });
      store.activateGuest(g1.id, "vm-1", "https://vm-1.vers.sh");

      expect(store.listGuests()).toHaveLength(2);
      expect(store.listGuests("running")).toHaveLength(1);
      expect(store.listGuests("provisioning")).toHaveLength(1);
    });
  });

  // -- Resource tracking tests ----------------------------------------------

  describe("resource limits", () => {
    it("updates usage and checks limits", () => {
      const inv = store.createInvite({
        createdBy: "noah",
        resourceLimits: { maxTokenBudget: 1000 },
      });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });

      store.updateUsage(guest.id, { tokensUsed: 500 });
      let check = store.checkLimits(guest.id);
      expect(check.exceeded).toBe(false);
      expect(check.violations).toHaveLength(0);

      store.updateUsage(guest.id, { tokensUsed: 1500 });
      check = store.checkLimits(guest.id);
      expect(check.exceeded).toBe(true);
      expect(check.violations).toHaveLength(1);
      expect(check.violations[0]).toContain("tokens");
    });

    it("checks multiple violations", () => {
      const inv = store.createInvite({
        createdBy: "noah",
        resourceLimits: { maxTokenBudget: 100, maxDiskGB: 1 },
      });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      store.updateUsage(guest.id, { tokensUsed: 200, diskUsedGB: 5 });

      const check = store.checkLimits(guest.id);
      expect(check.exceeded).toBe(true);
      expect(check.violations).toHaveLength(2);
    });
  });

  // -- Persistence tests ----------------------------------------------------

  describe("persistence", () => {
    it("survives reload", () => {
      const filePath = join(tmpDir, "persist-test.json");
      const store1 = new CouchStore(filePath);
      const inv = store1.createInvite({ createdBy: "noah" });
      const guest = store1.redeemInvite({ code: inv.code, name: "ty" });
      store1.flush();

      const store2 = new CouchStore(filePath);
      expect(store2.getInvite(inv.id)?.status).toBe("redeemed");
      expect(store2.getGuest(guest.id)?.name).toBe("ty");
    });
  });

  // -- Guest token lookup ---------------------------------------------------

  describe("getGuestByToken", () => {
    it("finds a running guest by auth token", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      store.activateGuest(guest.id, "vm-1", "https://vm-1.vers.sh");

      const found = store.getGuestByToken(guest.authToken);
      expect(found?.id).toBe(guest.id);
    });

    it("does not find a killed guest by token", () => {
      const inv = store.createInvite({ createdBy: "noah" });
      const guest = store.redeemInvite({ code: inv.code, name: "ty" });
      store.activateGuest(guest.id, "vm-1", "https://vm-1.vers.sh");
      store.killGuest(guest.id);

      expect(store.getGuestByToken(guest.authToken)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Route Integration Tests
// ---------------------------------------------------------------------------

describe("Couch Routes", () => {
  let app: Hono;
  let store: CouchStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "couch-route-test-"));
    store = new CouchStore(join(tmpDir, "couch.json"));

    // Build a test app with the couch routes wired to our test store
    const { Hono: H } = await import("hono");
    const { couchRoutes, couchPublicRoutes } = await import("../routes.js");

    // Mount both public (redeem) and authenticated routes, just like server.ts
    app = new H();
    app.route("/couch", couchPublicRoutes);
    app.route("/couch", couchRoutes);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /couch/invites → 201", async () => {
    const res = await app.request("/couch/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "noah", label: "test invite" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toMatch(/^inv_/);
    expect(body.label).toBe("test invite");
    expect(body.status).toBe("active");
  });

  it("GET /couch/invites → lists invites", async () => {
    // Create one via the route
    await app.request("/couch/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "noah" }),
    });

    const res = await app.request("/couch/invites");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it("POST /couch/redeem → 201 with guest token", async () => {
    // Create invite
    const invRes = await app.request("/couch/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "noah" }),
    });
    const inv = await invRes.json();

    // Redeem it
    const res = await app.request("/couch/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inv.code, name: "ty" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.guestId).toBeTruthy();
    expect(body.authToken).toMatch(/^guest_/);
    expect(body.status).toBe("provisioning");
    expect(body.resourceLimits).toBeTruthy();
  });

  it("POST /couch/redeem with bad code → 404", async () => {
    const res = await app.request("/couch/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "inv_bogus", name: "ty" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /couch/guests → lists guests without auth tokens", async () => {
    // Create + redeem
    const invRes = await app.request("/couch/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "noah" }),
    });
    const inv = await invRes.json();
    await app.request("/couch/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inv.code, name: "ty" }),
    });

    const res = await app.request("/couch/guests");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
    // Auth token should be stripped from list view
    const tyGuest = body.guests.find((g: any) => g.name === "ty");
    expect(tyGuest).toBeTruthy();
    expect(tyGuest.authToken).toBeUndefined();
  });

  it("GET /couch/guests/:id/status → resource usage", async () => {
    const invRes = await app.request("/couch/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "noah" }),
    });
    const inv = await invRes.json();
    const redeemRes = await app.request("/couch/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inv.code, name: "ty" }),
    });
    const guest = await redeemRes.json();

    const res = await app.request(`/couch/guests/${guest.guestId}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resourceUsage).toBeTruthy();
    expect(body.limitsExceeded).toBe(false);
  });

  it("DELETE /couch/guests/:id → kill switch", async () => {
    const invRes = await app.request("/couch/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdBy: "noah" }),
    });
    const inv = await invRes.json();
    const redeemRes = await app.request("/couch/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inv.code, name: "ty" }),
    });
    const guest = await redeemRes.json();

    const res = await app.request(`/couch/guests/${guest.guestId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("revoked");
  });

  it("DELETE /couch/guests/:id → 404 for unknown guest", async () => {
    const res = await app.request("/couch/guests/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
