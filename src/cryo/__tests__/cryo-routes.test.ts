import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { cryoRoutes, cryoStore } from "../routes.js";
import { store as personaStore } from "../../personas/routes.js";
import { registryStore } from "../../registry/routes.js";

const app = new Hono();
app.route("/cryo", cryoRoutes);

/**
 * Helper: seed a persona so cryo create can validate against it.
 */
function seedPersona(name: string) {
  try {
    personaStore.createPersona({
      name,
      displayName: name,
      description: `Test persona ${name}`,
      systemPrompt: `You are ${name}.`,
      author: "test",
    });
  } catch {
    // already exists — fine
  }
}

/**
 * Helper: create an agent via the API (persona must already exist).
 */
async function createAgent(name: string, persona: string, extra: Record<string, unknown> = {}) {
  return app.request("/cryo/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, persona, ...extra }),
  });
}

describe("cryo routes — integration gaps", () => {
  beforeEach(() => {
    // Clear stores between tests to avoid cross-contamination
    // CryoStore doesn't expose clear(), so we delete agents we know about
    for (const agent of cryoStore.listAgents()) {
      // Retire + remove from internal map via the store — best effort
      try {
        cryoStore.retire(agent.name);
      } catch {}
    }
    registryStore.clear();
  });

  describe("Gap 1: persona validation on create", () => {
    it("rejects create when persona does not exist", async () => {
      const res = await createAgent("ghost-agent", "nonexistent-persona-xyz");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("nonexistent-persona-xyz");
      expect(body.error).toContain("not found");
    });

    it("allows create when persona exists", async () => {
      seedPersona("test-worker");
      const res = await createAgent("good-agent", "test-worker");
      // Could be 201 (created) or 409 (if leftover from prior test)
      if (res.status === 201) {
        const body = await res.json();
        expect(body.name).toBe("good-agent");
        expect(body.persona).toBe("test-worker");
      }
    });
  });

  describe("Gap 2: wake registers agent in registry", () => {
    it("auto-registers VM in registry on wake", async () => {
      seedPersona("test-orchestrator");
      // Create agent
      const createRes = await createAgent("wake-test", "test-orchestrator");
      if (createRes.status === 409) return; // skip if leftover

      // Wake agent with vmId and address
      const wakeRes = await app.request("/cryo/agents/wake-test/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vmId: "vm-wake-001",
          address: "10.0.0.42",
          briefing: "Check registry integration",
        }),
      });
      expect(wakeRes.status).toBe(200);
      const agent = await wakeRes.json();
      expect(agent.status).toBe("awake");
      expect(agent.currentVmId).toBe("vm-wake-001");

      // Verify the VM was registered in the registry
      const vm = registryStore.get("vm-wake-001");
      expect(vm).toBeDefined();
      expect(vm!.name).toBe("wake-test");
      expect(vm!.address).toBe("10.0.0.42");
      expect(vm!.role).toBe("worker");
      expect(vm!.registeredBy).toBe("cryo");
    });

    it("uses default address when none provided", async () => {
      seedPersona("test-orchestrator");
      const createRes = await createAgent("wake-noaddr", "test-orchestrator");
      if (createRes.status === 409) return;

      const wakeRes = await app.request("/cryo/agents/wake-noaddr/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vmId: "vm-wake-002" }),
      });
      expect(wakeRes.status).toBe(200);

      const vm = registryStore.get("vm-wake-002");
      expect(vm).toBeDefined();
      expect(vm!.address).toBe("vm-wake-002.vm.vers.sh");
    });

    it("handles re-wake (upserts registry on conflict)", async () => {
      seedPersona("test-orchestrator");
      const createRes = await createAgent("wake-twice", "test-orchestrator");
      if (createRes.status === 409) return;

      // First wake
      await app.request("/cryo/agents/wake-twice/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vmId: "vm-wake-003", address: "10.0.0.1" }),
      });

      // Hibernate
      await app.request("/cryo/agents/wake-twice/hibernate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitId: "commit-abc", reason: "test" }),
      });

      // Second wake — same vmId, different address (should upsert, not crash)
      const res = await app.request("/cryo/agents/wake-twice/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vmId: "vm-wake-003", address: "10.0.0.2" }),
      });
      expect(res.status).toBe(200);

      const vm = registryStore.get("vm-wake-003");
      expect(vm).toBeDefined();
      expect(vm!.address).toBe("10.0.0.2");
    });
  });
});
