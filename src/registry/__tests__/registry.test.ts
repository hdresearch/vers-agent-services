import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RegistryStore,
  NotFoundError,
  ValidationError,
  ConflictError,
  type RegisterVMInput,
} from "../store.js";
import { registryRoutes, registryStore } from "../routes.js";

// --- Store unit tests ---

function makeInput(overrides: Partial<RegisterVMInput> = {}): RegisterVMInput {
  return {
    id: "vm-" + Math.random().toString(36).slice(2, 8),
    name: "test-vm",
    role: "worker",
    address: "test.vm.vers.sh",
    registeredBy: "test-agent",
    ...overrides,
  };
}

describe("RegistryStore", () => {
  let store: RegistryStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "registry-test-"));
    filePath = join(tmpDir, "registry.json");
    store = new RegistryStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("register", () => {
    it("registers a VM with defaults", () => {
      const vm = store.register(makeInput({ id: "vm-1", name: "infra" }));
      expect(vm.id).toBe("vm-1");
      expect(vm.name).toBe("infra");
      expect(vm.status).toBe("running");
      expect(vm.registeredAt).toBeTruthy();
      expect(vm.lastSeen).toBe(vm.registeredAt);
    });

    it("rejects duplicate IDs", () => {
      store.register(makeInput({ id: "vm-dup" }));
      expect(() => store.register(makeInput({ id: "vm-dup" }))).toThrow(ConflictError);
    });

    it("validates required fields", () => {
      expect(() => store.register(makeInput({ id: "" }))).toThrow(ValidationError);
      expect(() => store.register(makeInput({ name: "" }))).toThrow(ValidationError);
      expect(() => store.register(makeInput({ address: "" }))).toThrow(ValidationError);
      expect(() => store.register(makeInput({ registeredBy: "" }))).toThrow(ValidationError);
    });

    it("validates role", () => {
      expect(() => store.register(makeInput({ role: "bad" as any }))).toThrow(ValidationError);
    });

    it("validates status", () => {
      expect(() => store.register(makeInput({ status: "bad" as any }))).toThrow(ValidationError);
    });
  });

  describe("get / list", () => {
    it("gets a VM by ID", () => {
      store.register(makeInput({ id: "vm-1" }));
      expect(store.get("vm-1")).toBeTruthy();
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("lists all VMs", () => {
      store.register(makeInput({ id: "vm-1" }));
      store.register(makeInput({ id: "vm-2" }));
      expect(store.list()).toHaveLength(2);
    });

    it("filters by role", () => {
      store.register(makeInput({ id: "vm-1", role: "infra" }));
      store.register(makeInput({ id: "vm-2", role: "lieutenant" }));
      store.register(makeInput({ id: "vm-3", role: "infra" }));
      expect(store.list({ role: "infra" })).toHaveLength(2);
      expect(store.list({ role: "lieutenant" })).toHaveLength(1);
    });

    it("filters by status", () => {
      store.register(makeInput({ id: "vm-1", status: "running" }));
      store.register(makeInput({ id: "vm-2", status: "paused" }));
      // For non-running status, no stale check
      expect(store.list({ status: "paused" })).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates VM fields", () => {
      store.register(makeInput({ id: "vm-1", name: "old" }));
      const updated = store.update("vm-1", { name: "new", status: "paused" });
      expect(updated.name).toBe("new");
      expect(updated.status).toBe("paused");
    });

    it("updates metadata", () => {
      store.register(makeInput({ id: "vm-1" }));
      const updated = store.update("vm-1", { metadata: { taskCount: 5 } });
      expect(updated.metadata).toEqual({ taskCount: 5 });
    });

    it("throws NotFoundError for missing VM", () => {
      expect(() => store.update("nope", { status: "paused" })).toThrow(NotFoundError);
    });

    it("validates status", () => {
      store.register(makeInput({ id: "vm-1" }));
      expect(() => store.update("vm-1", { status: "bad" as any })).toThrow(ValidationError);
    });
  });

  describe("heartbeat", () => {
    it("updates lastSeen", async () => {
      const vm = store.register(makeInput({ id: "vm-1" }));
      const originalLastSeen = vm.lastSeen;
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));
      const updated = store.heartbeat("vm-1");
      expect(updated.lastSeen).not.toBe(originalLastSeen);
      expect(new Date(updated.lastSeen).getTime()).toBeGreaterThan(
        new Date(originalLastSeen).getTime()
      );
    });

    it("throws NotFoundError for missing VM", () => {
      expect(() => store.heartbeat("nope")).toThrow(NotFoundError);
    });
  });

  describe("deregister", () => {
    it("removes a VM", () => {
      store.register(makeInput({ id: "vm-1" }));
      expect(store.deregister("vm-1")).toBe(true);
      expect(store.get("vm-1")).toBeUndefined();
    });

    it("returns false for missing VM", () => {
      expect(store.deregister("nope")).toBe(false);
    });
  });

  describe("discover", () => {
    it("returns running VMs by role", () => {
      store.register(makeInput({ id: "vm-1", role: "infra" }));
      store.register(makeInput({ id: "vm-2", role: "lieutenant" }));
      store.register(makeInput({ id: "vm-3", role: "infra", status: "paused" }));
      const infras = store.discover("infra");
      expect(infras).toHaveLength(1);
      expect(infras[0].id).toBe("vm-1");
    });
  });

  describe("stale VM detection", () => {
    it("excludes stale VMs from discover", () => {
      // Use a very short stale threshold
      const shortStore = new RegistryStore(join(tmpDir, "short.json"), 1);
      shortStore.register(makeInput({ id: "vm-1", role: "infra" }));
      // Wait for it to go stale
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const results = shortStore.discover("infra");
          expect(results).toHaveLength(0);
          resolve();
        }, 10);
      });
    });

    it("excludes stale VMs when filtering status=running", () => {
      const shortStore = new RegistryStore(join(tmpDir, "short2.json"), 1);
      shortStore.register(makeInput({ id: "vm-1", role: "worker" }));
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const results = shortStore.list({ status: "running" });
          expect(results).toHaveLength(0);
          resolve();
        }, 10);
      });
    });

    it("heartbeat prevents staleness", () => {
      const shortStore = new RegistryStore(join(tmpDir, "short3.json"), 50);
      shortStore.register(makeInput({ id: "vm-1", role: "infra" }));
      // Heartbeat to keep alive
      shortStore.heartbeat("vm-1");
      const results = shortStore.discover("infra");
      expect(results).toHaveLength(1);
    });
  });

  describe("persistence", () => {
    it("persists to disk and reloads", () => {
      store.register(makeInput({ id: "vm-1", name: "persisted" }));
      store.flush();

      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      expect(data.vms).toHaveLength(1);
      expect(data.vms[0].name).toBe("persisted");

      // Reload from disk
      const store2 = new RegistryStore(filePath);
      expect(store2.get("vm-1")?.name).toBe("persisted");
    });
  });
});

// --- HTTP route tests ---

const app = new Hono();
app.route("/registry", registryRoutes);

function req(path: string, init?: RequestInit) {
  return app.request(`http://localhost/registry${path}`, init);
}

function registerVM(overrides: Record<string, unknown> = {}) {
  const body = {
    id: "vm-" + Math.random().toString(36).slice(2, 8),
    name: "test-vm",
    role: "worker",
    address: "test.vm.vers.sh",
    registeredBy: "test-agent",
    ...overrides,
  };
  return req("/vms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Registry Routes", () => {
  beforeEach(() => {
    registryStore.clear();
  });

  describe("POST /vms — Register", () => {
    it("registers a VM and returns 201", async () => {
      const res = await registerVM({ id: "vm-http-1" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("vm-http-1");
      expect(body.status).toBe("running");
    });

    it("returns 400 for missing fields", async () => {
      const res = await req("/vms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "no-id" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 for duplicate ID", async () => {
      await registerVM({ id: "vm-dup" });
      const res = await registerVM({ id: "vm-dup" });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /vms — List", () => {
    it("lists registered VMs", async () => {
      await registerVM({ id: "vm-a" });
      await registerVM({ id: "vm-b" });
      const res = await req("/vms");
      const body = await res.json();
      expect(body.count).toBe(2);
      expect(body.vms).toHaveLength(2);
    });

    it("filters by role", async () => {
      await registerVM({ id: "vm-a", role: "infra" });
      await registerVM({ id: "vm-b", role: "lieutenant" });
      const res = await req("/vms?role=infra");
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.vms[0].role).toBe("infra");
    });

    it("filters by status", async () => {
      await registerVM({ id: "vm-a", status: "running" });
      await registerVM({ id: "vm-b", status: "paused" });
      const res = await req("/vms?status=paused");
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.vms[0].status).toBe("paused");
    });
  });

  describe("GET /vms/:id — Get", () => {
    it("returns a single VM", async () => {
      await registerVM({ id: "vm-get" });
      const res = await req("/vms/vm-get");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("vm-get");
    });

    it("returns 404 for missing VM", async () => {
      const res = await req("/vms/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /vms/:id — Update", () => {
    it("updates VM fields", async () => {
      await registerVM({ id: "vm-upd" });
      const res = await req("/vms/vm-upd", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused", metadata: { reason: "test" } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("paused");
      expect(body.metadata).toEqual({ reason: "test" });
    });

    it("returns 404 for missing VM", async () => {
      const res = await req("/vms/nope", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /vms/:id — Deregister", () => {
    it("deletes a VM", async () => {
      await registerVM({ id: "vm-del" });
      const res = await req("/vms/vm-del", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);

      const getRes = await req("/vms/vm-del");
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for missing VM", async () => {
      const res = await req("/vms/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /vms/:id/heartbeat — Heartbeat", () => {
    it("updates lastSeen", async () => {
      await registerVM({ id: "vm-hb" });

      // Small delay
      await new Promise((r) => setTimeout(r, 10));

      const res = await req("/vms/vm-hb/heartbeat", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("vm-hb");
      expect(body.lastSeen).toBeTruthy();
    });

    it("returns 404 for missing VM", async () => {
      const res = await req("/vms/nope/heartbeat", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /discover/:role — Discovery", () => {
    it("returns running VMs by role", async () => {
      await registerVM({ id: "vm-i1", role: "infra" });
      await registerVM({ id: "vm-i2", role: "infra" });
      await registerVM({ id: "vm-lt", role: "lieutenant" });

      const res = await req("/discover/infra");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(2);
      expect(body.vms.every((v: any) => v.role === "infra")).toBe(true);
    });

    it("excludes paused VMs", async () => {
      await registerVM({ id: "vm-i1", role: "infra" });
      await registerVM({ id: "vm-i2", role: "infra", status: "paused" });

      const res = await req("/discover/infra");
      const body = await res.json();
      expect(body.count).toBe(1);
    });

    it("returns empty for unknown role", async () => {
      const res = await req("/discover/golden");
      const body = await res.json();
      expect(body.count).toBe(0);
      expect(body.vms).toEqual([]);
    });
  });
});
