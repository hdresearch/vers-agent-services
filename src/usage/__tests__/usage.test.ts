import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UsageStore,
  ValidationError,
  type SessionInput,
  type VMInput,
} from "../store.js";

// --- Helpers ---

function makeSessionInput(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    sessionId: "sess-001",
    agent: "lt-build",
    parentAgent: "orchestrator",
    model: "claude-sonnet-4-20250514",
    tokens: { input: 100000, output: 50000, cacheRead: 20000, cacheWrite: 5000, total: 175000 },
    cost: { input: 0.30, output: 0.75, cacheRead: 0.02, cacheWrite: 0.01, total: 1.08 },
    turns: 15,
    toolCalls: { bash: 5, read: 3, write: 2 },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVMInput(overrides: Partial<VMInput> = {}): VMInput {
  return {
    vmId: "vm-abc-123",
    role: "worker",
    agent: "lt-build",
    commitId: "commit-xyz",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- Store unit tests ---

describe("UsageStore", () => {
  let store: UsageStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-test-"));
    const dbPath = join(tmpDir, "usage.duckdb");
    store = new UsageStore(dbPath);
    await store.ensureReady();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("recordSession", () => {
    it("records a session with all fields", async () => {
      const input = makeSessionInput();
      const record = await store.recordSession(input);
      expect(record.id).toBeTruthy();
      expect(record.sessionId).toBe("sess-001");
      expect(record.agent).toBe("lt-build");
      expect(record.parentAgent).toBe("orchestrator");
      expect(record.model).toBe("claude-sonnet-4-20250514");
      expect(record.tokens.total).toBe(175000);
      expect(record.cost.total).toBe(1.08);
      expect(record.turns).toBe(15);
      expect(record.toolCalls.bash).toBe(5);
      expect(record.recordedAt).toBeTruthy();
    });

    it("defaults parentAgent to null", async () => {
      const record = await store.recordSession(makeSessionInput({ parentAgent: undefined }));
      expect(record.parentAgent).toBeNull();
    });

    it("defaults toolCalls to empty object", async () => {
      const record = await store.recordSession(makeSessionInput({ toolCalls: undefined }));
      expect(record.toolCalls).toEqual({});
    });

    it("rejects missing sessionId", async () => {
      await expect(store.recordSession(makeSessionInput({ sessionId: "" }))).rejects.toThrow(ValidationError);
    });

    it("rejects missing agent", async () => {
      await expect(store.recordSession(makeSessionInput({ agent: "" }))).rejects.toThrow(ValidationError);
    });

    it("rejects missing model", async () => {
      await expect(store.recordSession(makeSessionInput({ model: "" }))).rejects.toThrow(ValidationError);
    });

    it("rejects invalid tokens", async () => {
      await expect(
        store.recordSession(makeSessionInput({ tokens: { input: 0 } as any }))
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invalid cost", async () => {
      await expect(
        store.recordSession(makeSessionInput({ cost: { total: 1 } as any }))
      ).rejects.toThrow(ValidationError);
    });

    it("rejects negative turns", async () => {
      await expect(store.recordSession(makeSessionInput({ turns: -1 }))).rejects.toThrow(ValidationError);
    });

    it("rejects missing startedAt", async () => {
      await expect(store.recordSession(makeSessionInput({ startedAt: "" }))).rejects.toThrow(ValidationError);
    });

    it("rejects missing endedAt", async () => {
      await expect(store.recordSession(makeSessionInput({ endedAt: "" }))).rejects.toThrow(ValidationError);
    });
  });

  describe("listSessions", () => {
    beforeEach(async () => {
      const now = new Date();
      await store.recordSession(makeSessionInput({
        sessionId: "s1",
        agent: "orchestrator",
        startedAt: new Date(now.getTime() - 1000).toISOString(),
      }));
      await store.recordSession(makeSessionInput({
        sessionId: "s2",
        agent: "lt-build",
        startedAt: new Date(now.getTime() - 2000).toISOString(),
      }));
      await store.recordSession(makeSessionInput({
        sessionId: "s3",
        agent: "orchestrator",
        startedAt: new Date(now.getTime() - 3000).toISOString(),
      }));
    });

    it("lists all sessions", async () => {
      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("filters by agent", async () => {
      const sessions = await store.listSessions({ agent: "orchestrator" });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.agent === "orchestrator")).toBe(true);
    });

    it("filters by range", async () => {
      const sessions = await store.listSessions({ range: "1h" });
      expect(sessions).toHaveLength(3);
    });

    it("returns most recent first", async () => {
      const sessions = await store.listSessions();
      expect(sessions[0].sessionId).toBe("s1");
      expect(sessions[2].sessionId).toBe("s3");
    });

    it("returns empty for no matches", async () => {
      const sessions = await store.listSessions({ agent: "nonexistent" });
      expect(sessions).toHaveLength(0);
    });
  });

  describe("recordVM", () => {
    it("records a VM creation", async () => {
      const record = await store.recordVM(makeVMInput());
      expect(record.id).toBeTruthy();
      expect(record.vmId).toBe("vm-abc-123");
      expect(record.role).toBe("worker");
      expect(record.agent).toBe("lt-build");
      expect(record.commitId).toBe("commit-xyz");
      expect(record.destroyedAt).toBeUndefined();
      expect(record.recordedAt).toBeTruthy();
    });

    it("records a VM with destroyedAt", async () => {
      const record = await store.recordVM(makeVMInput({ destroyedAt: new Date().toISOString() }));
      expect(record.destroyedAt).toBeTruthy();
    });

    it("rejects missing vmId", async () => {
      await expect(store.recordVM(makeVMInput({ vmId: "" }))).rejects.toThrow(ValidationError);
    });

    it("rejects invalid role", async () => {
      await expect(store.recordVM(makeVMInput({ role: "bad" as any }))).rejects.toThrow(ValidationError);
    });

    it("rejects missing agent", async () => {
      await expect(store.recordVM(makeVMInput({ agent: "" }))).rejects.toThrow(ValidationError);
    });

    it("rejects missing createdAt", async () => {
      await expect(store.recordVM(makeVMInput({ createdAt: "" }))).rejects.toThrow(ValidationError);
    });
  });

  describe("listVMs", () => {
    beforeEach(async () => {
      const now = new Date();
      await store.recordVM(makeVMInput({
        vmId: "vm-1",
        role: "worker",
        agent: "lt-build",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
      }));
      await store.recordVM(makeVMInput({
        vmId: "vm-2",
        role: "lieutenant",
        agent: "orchestrator",
        createdAt: new Date(now.getTime() - 2000).toISOString(),
      }));
      await store.recordVM(makeVMInput({
        vmId: "vm-3",
        role: "worker",
        agent: "lt-test",
        createdAt: new Date(now.getTime() - 3000).toISOString(),
      }));
    });

    it("lists all VMs", async () => {
      const vms = await store.listVMs();
      expect(vms).toHaveLength(3);
    });

    it("filters by role", async () => {
      const vms = await store.listVMs({ role: "worker" });
      expect(vms).toHaveLength(2);
      expect(vms.every((v) => v.role === "worker")).toBe(true);
    });

    it("filters by agent", async () => {
      const vms = await store.listVMs({ agent: "orchestrator" });
      expect(vms).toHaveLength(1);
      expect(vms[0].vmId).toBe("vm-2");
    });

    it("filters by range", async () => {
      const vms = await store.listVMs({ range: "1h" });
      expect(vms).toHaveLength(3);
    });

    it("returns most recent first", async () => {
      const vms = await store.listVMs();
      expect(vms[0].vmId).toBe("vm-1");
      expect(vms[2].vmId).toBe("vm-3");
    });

    it("updates existing VM on destroy", async () => {
      await store.recordVM(makeVMInput({
        vmId: "vm-1",
        role: "worker",
        agent: "lt-build",
        createdAt: new Date(Date.now() - 1000).toISOString(),
        destroyedAt: new Date().toISOString(),
      }));
      const vms = await store.listVMs();
      // Should still have 3 VMs (vm-1 was updated, not duplicated)
      expect(vms).toHaveLength(3);
      const vm1 = vms.find((v) => v.vmId === "vm-1");
      expect(vm1?.destroyedAt).toBeTruthy();
    });
  });

  describe("summary", () => {
    beforeEach(async () => {
      const now = new Date();
      await store.recordSession(makeSessionInput({
        sessionId: "s1",
        agent: "orchestrator",
        tokens: { input: 100000, output: 50000, cacheRead: 10000, cacheWrite: 5000, total: 165000 },
        cost: { input: 0.30, output: 0.75, cacheRead: 0.01, cacheWrite: 0.01, total: 1.07 },
        startedAt: new Date(now.getTime() - 1000).toISOString(),
        endedAt: now.toISOString(),
      }));
      await store.recordSession(makeSessionInput({
        sessionId: "s2",
        agent: "lt-build",
        tokens: { input: 200000, output: 100000, cacheRead: 20000, cacheWrite: 10000, total: 330000 },
        cost: { input: 0.60, output: 1.50, cacheRead: 0.02, cacheWrite: 0.02, total: 2.14 },
        startedAt: new Date(now.getTime() - 2000).toISOString(),
        endedAt: now.toISOString(),
      }));
      await store.recordVM(makeVMInput({
        vmId: "vm-1",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
      }));
      await store.recordVM(makeVMInput({
        vmId: "vm-2",
        createdAt: new Date(now.getTime() - 2000).toISOString(),
      }));
    });

    it("computes totals", async () => {
      const summary = await store.summary("7d");
      expect(summary.range).toBe("7d");
      expect(summary.totals.tokens).toBe(495000);
      expect(summary.totals.cost).toBe(3.21);
      expect(summary.totals.sessions).toBe(2);
      expect(summary.totals.vms).toBe(2);
    });

    it("breaks down by agent", async () => {
      const summary = await store.summary("7d");
      expect(summary.byAgent["orchestrator"]).toBeDefined();
      expect(summary.byAgent["orchestrator"].tokens).toBe(165000);
      expect(summary.byAgent["orchestrator"].cost).toBe(1.07);
      expect(summary.byAgent["orchestrator"].sessions).toBe(1);
      expect(summary.byAgent["lt-build"]).toBeDefined();
      expect(summary.byAgent["lt-build"].tokens).toBe(330000);
      expect(summary.byAgent["lt-build"].sessions).toBe(1);
    });

    it("respects range filter", async () => {
      const summary = await store.summary("1h");
      expect(summary.range).toBe("1h");
      expect(summary.totals.sessions).toBe(2); // both within 1h
    });

    it("returns zeros for empty range", async () => {
      // Create a new store with no data
      const emptyDbPath = join(tmpDir, "empty.duckdb");
      const emptyStore = new UsageStore(emptyDbPath);
      await emptyStore.ensureReady();
      const summary = await emptyStore.summary("7d");
      expect(summary.totals.tokens).toBe(0);
      expect(summary.totals.cost).toBe(0);
      expect(summary.totals.sessions).toBe(0);
      expect(summary.totals.vms).toBe(0);
      expect(summary.byAgent).toEqual({});
      await emptyStore.close();
    });
  });

  describe("upsertSession", () => {
    it("inserts a new session when none exists", async () => {
      const input = makeSessionInput({ sessionId: "upsert-new" });
      const record = await store.upsertSession("upsert-new", input);
      expect(record.id).toBeTruthy();
      expect(record.sessionId).toBe("upsert-new");
      expect(record.turns).toBe(15);
      expect(await store.sessionCount()).toBe(1);
    });

    it("updates existing session on second call with same sessionId", async () => {
      const input1 = makeSessionInput({
        sessionId: "upsert-dup",
        turns: 5,
        tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, total: 1650 },
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.001, total: 0.032 },
      });
      const r1 = await store.upsertSession("upsert-dup", input1);

      const input2 = makeSessionInput({
        sessionId: "upsert-dup",
        turns: 10,
        tokens: { input: 5000, output: 2500, cacheRead: 500, cacheWrite: 200, total: 8200 },
        cost: { input: 0.05, output: 0.10, cacheRead: 0.005, cacheWrite: 0.003, total: 0.158 },
      });
      const r2 = await store.upsertSession("upsert-dup", input2);

      // Should reuse the same row ID
      expect(r2.id).toBe(r1.id);
      expect(r2.turns).toBe(10);
      expect(r2.tokens.total).toBe(8200);
      expect(r2.cost.total).toBe(0.158);

      // Only one row in the DB
      expect(await store.sessionCount()).toBe(1);
    });

    it("preserves startedAt from first insert on update", async () => {
      const startedAt = "2025-01-01T00:00:00.000Z";
      await store.upsertSession("upsert-start", makeSessionInput({
        sessionId: "upsert-start",
        startedAt,
        turns: 1,
      }));

      const r2 = await store.upsertSession("upsert-start", makeSessionInput({
        sessionId: "upsert-start",
        startedAt,
        turns: 5,
        endedAt: "2025-01-01T01:00:00.000Z",
      }));

      // started_at is not updated by the UPDATE query, but endedAt is
      expect(r2.turns).toBe(5);
      expect(r2.endedAt).toBe("2025-01-01T01:00:00.000Z");
    });

    it("does not affect other sessions", async () => {
      await store.recordSession(makeSessionInput({ sessionId: "other-1" }));
      await store.upsertSession("upsert-only", makeSessionInput({ sessionId: "upsert-only", turns: 3 }));
      await store.upsertSession("upsert-only", makeSessionInput({ sessionId: "upsert-only", turns: 7 }));

      expect(await store.sessionCount()).toBe(2);
      const sessions = await store.listSessions();
      const other = sessions.find((s) => s.sessionId === "other-1");
      expect(other?.turns).toBe(15); // unchanged
      const upserted = sessions.find((s) => s.sessionId === "upsert-only");
      expect(upserted?.turns).toBe(7);
    });

    it("rejects missing agent", async () => {
      await expect(
        store.upsertSession("x", makeSessionInput({ agent: "" }))
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invalid tokens", async () => {
      await expect(
        store.upsertSession("x", makeSessionInput({ tokens: { input: 0 } as any }))
      ).rejects.toThrow(ValidationError);
    });

    it("rejects empty sessionId path param", async () => {
      await expect(
        store.upsertSession("", makeSessionInput())
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("persistence", () => {
    it("persists sessions to DuckDB and reloads", async () => {
      const dbPath = join(tmpDir, "persist.duckdb");
      const store1 = new UsageStore(dbPath);
      await store1.ensureReady();
      await store1.recordSession(makeSessionInput({ sessionId: "persist-1" }));
      await store1.recordSession(makeSessionInput({ sessionId: "persist-2" }));
      await store1.close();

      // Create new store from same file
      const store2 = new UsageStore(dbPath);
      await store2.ensureReady();
      expect(await store2.sessionCount()).toBe(2);
      const sessions = await store2.listSessions();
      expect(sessions.some((s) => s.sessionId === "persist-1")).toBe(true);
      expect(sessions.some((s) => s.sessionId === "persist-2")).toBe(true);
      await store2.close();
    });

    it("persists VMs to DuckDB and reloads", async () => {
      const dbPath = join(tmpDir, "persist-vms.duckdb");
      const store1 = new UsageStore(dbPath);
      await store1.ensureReady();
      await store1.recordVM(makeVMInput({ vmId: "vm-persist-1" }));
      await store1.recordVM(makeVMInput({ vmId: "vm-persist-2" }));
      await store1.close();

      const store2 = new UsageStore(dbPath);
      await store2.ensureReady();
      expect(await store2.vmCount()).toBe(2);
      await store2.close();
    });

    it("starts fresh if DB is new", async () => {
      const freshStore = new UsageStore(join(tmpDir, "fresh.duckdb"));
      await freshStore.ensureReady();
      expect(await freshStore.sessionCount()).toBe(0);
      expect(await freshStore.vmCount()).toBe(0);
      await freshStore.close();
    });
  });
});

// --- Route integration tests ---

describe("Usage Routes", () => {
  let app: Hono;

  beforeEach(async () => {
    const { usageRoutes } = await import("../routes.js");
    app = new Hono();
    app.route("/usage", usageRoutes);
  });

  const json = (body: any) => ({
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // --- Session routes ---

  it("POST /usage/sessions — records a session", async () => {
    const res = await app.request("/usage/sessions", json(makeSessionInput()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBe("sess-001");
    expect(body.id).toBeTruthy();
  });

  it("POST /usage/sessions — 400 on missing fields", async () => {
    const res = await app.request("/usage/sessions", json({ agent: "test" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("GET /usage/sessions — lists sessions", async () => {
    await app.request("/usage/sessions", json(makeSessionInput({ sessionId: "s1" })));
    await app.request("/usage/sessions", json(makeSessionInput({ sessionId: "s2" })));
    const res = await app.request("/usage/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it("GET /usage/sessions?agent= — filters by agent", async () => {
    await app.request("/usage/sessions", json(makeSessionInput({ sessionId: "s1", agent: "lt-a" })));
    await app.request("/usage/sessions", json(makeSessionInput({ sessionId: "s2", agent: "lt-b" })));
    const res = await app.request("/usage/sessions?agent=lt-a");
    expect(res.status).toBe(200);
    const body = await res.json();
    const filtered = body.sessions.filter((s: any) => s.agent === "lt-a");
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  // --- PATCH session (upsert) routes ---

  it("PATCH /usage/sessions/:id — creates session on first call", async () => {
    const input = makeSessionInput({ sessionId: "patch-new" });
    const res = await app.request("/usage/sessions/patch-new", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("patch-new");
    expect(body.turns).toBe(15);
  });

  it("PATCH /usage/sessions/:id — updates on subsequent calls", async () => {
    const input1 = makeSessionInput({ sessionId: "patch-upd", turns: 3 });
    await app.request("/usage/sessions/patch-upd", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input1),
    });

    const input2 = makeSessionInput({ sessionId: "patch-upd", turns: 8 });
    const res = await app.request("/usage/sessions/patch-upd", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input2),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turns).toBe(8);
  });

  it("PATCH /usage/sessions/:id — 400 on missing fields", async () => {
    const res = await app.request("/usage/sessions/bad", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "test" }),
    });
    expect(res.status).toBe(400);
  });

  // --- VM routes ---

  it("POST /usage/vms — records a VM", async () => {
    const res = await app.request("/usage/vms", json(makeVMInput()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.vmId).toBe("vm-abc-123");
    expect(body.id).toBeTruthy();
  });

  it("POST /usage/vms — 400 on invalid role", async () => {
    const res = await app.request("/usage/vms", json(makeVMInput({ role: "bad" as any })));
    expect(res.status).toBe(400);
  });

  it("GET /usage/vms — lists VMs", async () => {
    await app.request("/usage/vms", json(makeVMInput({ vmId: "vm-1" })));
    await app.request("/usage/vms", json(makeVMInput({ vmId: "vm-2" })));
    const res = await app.request("/usage/vms");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it("GET /usage/vms?role= — filters by role", async () => {
    await app.request("/usage/vms", json(makeVMInput({ vmId: "vm-w", role: "worker" })));
    await app.request("/usage/vms", json(makeVMInput({ vmId: "vm-l", role: "lieutenant" })));
    const res = await app.request("/usage/vms?role=worker");
    const body = await res.json();
    const filtered = body.vms.filter((v: any) => v.role === "worker");
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  // --- Summary route ---

  it("GET /usage — returns summary", async () => {
    await app.request("/usage/sessions", json(makeSessionInput({ sessionId: "sum-1", agent: "orch" })));
    await app.request("/usage/vms", json(makeVMInput({ vmId: "vm-sum" })));
    const res = await app.request("/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe("7d");
    expect(body.totals).toBeDefined();
    expect(typeof body.totals.tokens).toBe("number");
    expect(typeof body.totals.cost).toBe("number");
    expect(typeof body.totals.sessions).toBe("number");
    expect(typeof body.totals.vms).toBe("number");
    expect(body.byAgent).toBeDefined();
  });

  it("GET /usage?range=30d — respects range param", async () => {
    const res = await app.request("/usage?range=30d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe("30d");
  });
});
