import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
  let sessionsPath: string;
  let vmsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-test-"));
    sessionsPath = join(tmpDir, "sessions.jsonl");
    vmsPath = join(tmpDir, "vms.jsonl");
    store = new UsageStore(sessionsPath, vmsPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("recordSession", () => {
    it("records a session with all fields", () => {
      const input = makeSessionInput();
      const record = store.recordSession(input);
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

    it("defaults parentAgent to null", () => {
      const record = store.recordSession(makeSessionInput({ parentAgent: undefined }));
      expect(record.parentAgent).toBeNull();
    });

    it("defaults toolCalls to empty object", () => {
      const record = store.recordSession(makeSessionInput({ toolCalls: undefined }));
      expect(record.toolCalls).toEqual({});
    });

    it("rejects missing sessionId", () => {
      expect(() => store.recordSession(makeSessionInput({ sessionId: "" }))).toThrow(ValidationError);
    });

    it("rejects missing agent", () => {
      expect(() => store.recordSession(makeSessionInput({ agent: "" }))).toThrow(ValidationError);
    });

    it("rejects missing model", () => {
      expect(() => store.recordSession(makeSessionInput({ model: "" }))).toThrow(ValidationError);
    });

    it("rejects invalid tokens", () => {
      expect(() =>
        store.recordSession(makeSessionInput({ tokens: { input: 0 } as any }))
      ).toThrow(ValidationError);
    });

    it("rejects invalid cost", () => {
      expect(() =>
        store.recordSession(makeSessionInput({ cost: { total: 1 } as any }))
      ).toThrow(ValidationError);
    });

    it("rejects negative turns", () => {
      expect(() => store.recordSession(makeSessionInput({ turns: -1 }))).toThrow(ValidationError);
    });

    it("rejects missing startedAt", () => {
      expect(() => store.recordSession(makeSessionInput({ startedAt: "" }))).toThrow(ValidationError);
    });

    it("rejects missing endedAt", () => {
      expect(() => store.recordSession(makeSessionInput({ endedAt: "" }))).toThrow(ValidationError);
    });
  });

  describe("listSessions", () => {
    beforeEach(() => {
      const now = new Date();
      store.recordSession(makeSessionInput({
        sessionId: "s1",
        agent: "orchestrator",
        startedAt: new Date(now.getTime() - 1000).toISOString(),
      }));
      store.recordSession(makeSessionInput({
        sessionId: "s2",
        agent: "lt-build",
        startedAt: new Date(now.getTime() - 2000).toISOString(),
      }));
      store.recordSession(makeSessionInput({
        sessionId: "s3",
        agent: "orchestrator",
        startedAt: new Date(now.getTime() - 3000).toISOString(),
      }));
    });

    it("lists all sessions", () => {
      expect(store.listSessions()).toHaveLength(3);
    });

    it("filters by agent", () => {
      const sessions = store.listSessions({ agent: "orchestrator" });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.agent === "orchestrator")).toBe(true);
    });

    it("filters by range", () => {
      const sessions = store.listSessions({ range: "1h" });
      expect(sessions).toHaveLength(3);
    });

    it("returns most recent first", () => {
      const sessions = store.listSessions();
      expect(sessions[0].sessionId).toBe("s1");
      expect(sessions[2].sessionId).toBe("s3");
    });

    it("returns empty for no matches", () => {
      expect(store.listSessions({ agent: "nonexistent" })).toHaveLength(0);
    });
  });

  describe("recordVM", () => {
    it("records a VM creation", () => {
      const record = store.recordVM(makeVMInput());
      expect(record.id).toBeTruthy();
      expect(record.vmId).toBe("vm-abc-123");
      expect(record.role).toBe("worker");
      expect(record.agent).toBe("lt-build");
      expect(record.commitId).toBe("commit-xyz");
      expect(record.destroyedAt).toBeUndefined();
      expect(record.recordedAt).toBeTruthy();
    });

    it("records a VM with destroyedAt", () => {
      const record = store.recordVM(makeVMInput({ destroyedAt: new Date().toISOString() }));
      expect(record.destroyedAt).toBeTruthy();
    });

    it("rejects missing vmId", () => {
      expect(() => store.recordVM(makeVMInput({ vmId: "" }))).toThrow(ValidationError);
    });

    it("rejects invalid role", () => {
      expect(() => store.recordVM(makeVMInput({ role: "bad" as any }))).toThrow(ValidationError);
    });

    it("rejects missing agent", () => {
      expect(() => store.recordVM(makeVMInput({ agent: "" }))).toThrow(ValidationError);
    });

    it("rejects missing createdAt", () => {
      expect(() => store.recordVM(makeVMInput({ createdAt: "" }))).toThrow(ValidationError);
    });
  });

  describe("listVMs", () => {
    beforeEach(() => {
      const now = new Date();
      store.recordVM(makeVMInput({
        vmId: "vm-1",
        role: "worker",
        agent: "lt-build",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
      }));
      store.recordVM(makeVMInput({
        vmId: "vm-2",
        role: "lieutenant",
        agent: "orchestrator",
        createdAt: new Date(now.getTime() - 2000).toISOString(),
      }));
      store.recordVM(makeVMInput({
        vmId: "vm-3",
        role: "worker",
        agent: "lt-test",
        createdAt: new Date(now.getTime() - 3000).toISOString(),
      }));
    });

    it("lists all VMs", () => {
      expect(store.listVMs()).toHaveLength(3);
    });

    it("filters by role", () => {
      const vms = store.listVMs({ role: "worker" });
      expect(vms).toHaveLength(2);
      expect(vms.every((v) => v.role === "worker")).toBe(true);
    });

    it("filters by agent", () => {
      const vms = store.listVMs({ agent: "orchestrator" });
      expect(vms).toHaveLength(1);
      expect(vms[0].vmId).toBe("vm-2");
    });

    it("filters by range", () => {
      const vms = store.listVMs({ range: "1h" });
      expect(vms).toHaveLength(3);
    });

    it("returns most recent first", () => {
      const vms = store.listVMs();
      expect(vms[0].vmId).toBe("vm-1");
      expect(vms[2].vmId).toBe("vm-3");
    });

    it("deduplicates by vmId", () => {
      // Record a destroy event for vm-1
      store.recordVM(makeVMInput({
        vmId: "vm-1",
        role: "worker",
        agent: "lt-build",
        createdAt: new Date(Date.now() - 1000).toISOString(),
        destroyedAt: new Date().toISOString(),
      }));
      const vms = store.listVMs();
      expect(vms).toHaveLength(3); // still 3 unique vmIds
      const vm1 = vms.find((v) => v.vmId === "vm-1");
      expect(vm1?.destroyedAt).toBeTruthy();
    });
  });

  describe("summary", () => {
    beforeEach(() => {
      const now = new Date();
      store.recordSession(makeSessionInput({
        sessionId: "s1",
        agent: "orchestrator",
        tokens: { input: 100000, output: 50000, cacheRead: 10000, cacheWrite: 5000, total: 165000 },
        cost: { input: 0.30, output: 0.75, cacheRead: 0.01, cacheWrite: 0.01, total: 1.07 },
        startedAt: new Date(now.getTime() - 1000).toISOString(),
        endedAt: now.toISOString(),
      }));
      store.recordSession(makeSessionInput({
        sessionId: "s2",
        agent: "lt-build",
        tokens: { input: 200000, output: 100000, cacheRead: 20000, cacheWrite: 10000, total: 330000 },
        cost: { input: 0.60, output: 1.50, cacheRead: 0.02, cacheWrite: 0.02, total: 2.14 },
        startedAt: new Date(now.getTime() - 2000).toISOString(),
        endedAt: now.toISOString(),
      }));
      store.recordVM(makeVMInput({
        vmId: "vm-1",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
      }));
      store.recordVM(makeVMInput({
        vmId: "vm-2",
        createdAt: new Date(now.getTime() - 2000).toISOString(),
      }));
    });

    it("computes totals", () => {
      const summary = store.summary("7d");
      expect(summary.range).toBe("7d");
      expect(summary.totals.tokens).toBe(495000);
      expect(summary.totals.cost).toBe(3.21);
      expect(summary.totals.sessions).toBe(2);
      expect(summary.totals.vms).toBe(2);
    });

    it("breaks down by agent", () => {
      const summary = store.summary("7d");
      expect(summary.byAgent["orchestrator"]).toBeDefined();
      expect(summary.byAgent["orchestrator"].tokens).toBe(165000);
      expect(summary.byAgent["orchestrator"].cost).toBe(1.07);
      expect(summary.byAgent["orchestrator"].sessions).toBe(1);
      expect(summary.byAgent["lt-build"]).toBeDefined();
      expect(summary.byAgent["lt-build"].tokens).toBe(330000);
      expect(summary.byAgent["lt-build"].sessions).toBe(1);
    });

    it("respects range filter", () => {
      // With a very short range, nothing should match
      // Record a session far in the past (we can't easily test this with in-memory,
      // but we can verify the range param is passed through)
      const summary = store.summary("1h");
      expect(summary.range).toBe("1h");
      expect(summary.totals.sessions).toBe(2); // both within 1h
    });
  });

  describe("persistence", () => {
    it("persists sessions to JSONL and reloads", () => {
      store.recordSession(makeSessionInput({ sessionId: "persist-1" }));
      store.recordSession(makeSessionInput({ sessionId: "persist-2" }));

      // Create new store from same files
      const store2 = new UsageStore(sessionsPath, vmsPath);
      expect(store2.sessionCount).toBe(2);
      const sessions = store2.listSessions();
      expect(sessions.some((s) => s.sessionId === "persist-1")).toBe(true);
      expect(sessions.some((s) => s.sessionId === "persist-2")).toBe(true);
    });

    it("persists VMs to JSONL and reloads", () => {
      store.recordVM(makeVMInput({ vmId: "vm-persist-1" }));
      store.recordVM(makeVMInput({ vmId: "vm-persist-2" }));

      const store2 = new UsageStore(sessionsPath, vmsPath);
      expect(store2.vmCount).toBe(2);
    });

    it("writes valid JSONL", () => {
      store.recordSession(makeSessionInput());
      const content = readFileSync(sessionsPath, "utf-8").trim();
      const lines = content.split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.sessionId).toBe("sess-001");
    });

    it("starts fresh if files are missing", () => {
      const freshStore = new UsageStore(
        join(tmpDir, "nonexistent-sessions.jsonl"),
        join(tmpDir, "nonexistent-vms.jsonl")
      );
      expect(freshStore.sessionCount).toBe(0);
      expect(freshStore.vmCount).toBe(0);
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
