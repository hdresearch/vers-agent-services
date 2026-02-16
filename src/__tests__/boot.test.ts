import { describe, it, expect, beforeEach } from "vitest";
import { registerAgent, getBriefing, heartbeat, debrief } from "../boot/protocol.js";
import { cryoStore } from "../cryo/routes.js";
import { store as personaStore } from "../personas/routes.js";
import { registryStore } from "../registry/routes.js";

// Helper to create a test persona
function seedPersona(name = "test-persona") {
  try {
    personaStore.createPersona({
      name,
      displayName: "Test Persona",
      description: "A test persona for boot tests",
      systemPrompt: "You are a test agent.",
      traits: ["careful", "precise"],
      specializations: ["testing"],
      author: "test",
      tags: ["test"],
    });
  } catch {
    // already exists
  }
}

describe("Boot Protocol", () => {
  beforeEach(() => {
    // Clear stores for isolation
    // CryoStore and PersonaStore use file-backed storage,
    // so we work with unique names per test
  });

  describe("registerAgent", () => {
    it("registers a named agent and returns identity + briefing", () => {
      const name = `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      seedPersona();

      const result = registerAgent({
        vmId: `vm-${name}`,
        name,
        taskHint: "testing",
      });

      expect(result.identity).toBeDefined();
      expect(result.identity.name).toBe(name);
      expect(result.identity.status).toBe("awake");
      expect(result.identity.currentVmId).toBe(`vm-${name}`);
      expect(result.kbBriefing).toBeInstanceOf(Array);
      expect(result.recentLog).toBeInstanceOf(Array);
      expect(result.boardTasks).toBeInstanceOf(Array);
      expect(result.fleetStatus).toBeDefined();
      expect(typeof result.fleetStatus.activeVMs).toBe("number");

      // Cleanup
      try { cryoStore.updateAgent(name, { status: "retired" as any }); } catch {}
      try { registryStore.deregister(`vm-${name}`); } catch {}
    });

    it("assigns a generated name when no name is provided", () => {
      seedPersona();

      const result = registerAgent({
        vmId: `vm-auto-${Date.now()}`,
        taskHint: "testing",
      });

      expect(result.identity).toBeDefined();
      expect(result.identity.name).toBeTruthy();
      expect(result.identity.status).toBe("awake");

      // Cleanup
      try { cryoStore.updateAgent(result.identity.name, { status: "retired" as any }); } catch {}
      try { registryStore.deregister(`vm-auto-${Date.now()}`); } catch {}
    });

    it("restores a hibernating agent by name", () => {
      const name = `hibernate-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      seedPersona();

      // Create and hibernate
      cryoStore.createAgent({
        name,
        persona: "test-persona",
        currentVmId: "old-vm",
        status: "awake",
      });
      cryoStore.hibernate(name, {
        commitId: "commit-123",
        summary: "test hibernate",
        reason: "test",
      });

      const agent = cryoStore.getAgent(name);
      expect(agent.status).toBe("hibernating");

      // Now register (wake)
      const result = registerAgent({
        vmId: `vm-wake-${name}`,
        name,
      });

      expect(result.identity.status).toBe("awake");
      expect(result.identity.currentVmId).toBe(`vm-wake-${name}`);

      // Cleanup
      try { cryoStore.updateAgent(name, { status: "retired" as any }); } catch {}
    });

    it("rejects missing vmId", () => {
      expect(() => registerAgent({ vmId: "" })).toThrow("vmId is required");
    });
  });

  describe("getBriefing", () => {
    it("returns briefing for a known agent", () => {
      const name = `brief-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      seedPersona();

      cryoStore.createAgent({
        name,
        persona: "test-persona",
        currentVmId: "vm-brief",
        status: "awake",
      });

      const briefing = getBriefing(name);

      expect(briefing.identity).toBeDefined();
      expect(briefing.identity?.name).toBe(name);
      expect(briefing.persona).toBeDefined();
      expect(briefing.kbBriefing).toBeInstanceOf(Array);
      expect(briefing.recentFeed).toBeInstanceOf(Array);
      expect(briefing.boardTasks).toBeInstanceOf(Array);
      expect(briefing.fleetStatus).toBeDefined();
      expect(briefing.fleetChat).toBeInstanceOf(Array);
      expect(briefing.cryoHistory).toBeInstanceOf(Array);

      // Cleanup
      try { cryoStore.updateAgent(name, { status: "retired" as any }); } catch {}
    });

    it("returns partial briefing for unknown agent", () => {
      const briefing = getBriefing("nonexistent-agent-xyz");

      expect(briefing.identity).toBeNull();
      expect(briefing.persona).toBeNull();
      expect(briefing.kbBriefing).toBeInstanceOf(Array);
      expect(briefing.recentFeed).toBeInstanceOf(Array);
    });
  });

  describe("heartbeat", () => {
    it("returns ok with timestamp", () => {
      const result = heartbeat({
        agentName: "heartbeat-test",
        vmId: "vm-heartbeat-test",
      });

      expect(result.ok).toBe(true);
      expect(result.timestamp).toBeTruthy();
    });
  });

  describe("debrief", () => {
    it("debriefs a known agent", () => {
      const name = `debrief-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      seedPersona();

      cryoStore.createAgent({
        name,
        persona: "test-persona",
        currentVmId: "vm-debrief",
        status: "awake",
      });

      const result = debrief({
        agentName: name,
        summary: "Completed boot protocol implementation",
        artifacts: [{ type: "code", uri: "src/boot/protocol.ts", label: "Boot protocol" }],
      });

      expect(result.ok).toBe(true);
      expect(result.hibernated).toBe(true);

      // Verify the agent is hibernating
      const agent = cryoStore.getAgent(name);
      expect(agent.status).toBe("hibernating");
    });

    it("rejects missing fields", () => {
      expect(() => debrief({ agentName: "", summary: "test" })).toThrow("required");
      expect(() => debrief({ agentName: "test", summary: "" })).toThrow("required");
    });

    it("handles unknown agent gracefully", () => {
      const result = debrief({
        agentName: "nonexistent-agent-debrief",
        summary: "This agent was never registered",
      });

      expect(result.ok).toBe(true);
      expect(result.hibernated).toBe(false);
    });
  });
});
