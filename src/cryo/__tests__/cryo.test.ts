import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CryoStore, ValidationError, NotFoundError, ConflictError } from "../store.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_FILE = "data/test-cryo-agents.json";

function cleanup() {
  for (const f of [TEST_FILE, TEST_FILE + ".tmp"]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

describe("CryoStore", () => {
  let store: CryoStore;

  beforeEach(() => {
    cleanup();
    store = new CryoStore(TEST_FILE);
  });

  afterEach(() => {
    cleanup();
  });

  describe("createAgent", () => {
    it("creates an agent with defaults", () => {
      const agent = store.createAgent({ name: "puck", persona: "orchestrator" });
      expect(agent.name).toBe("puck");
      expect(agent.displayName).toBe("puck");
      expect(agent.persona).toBe("orchestrator");
      expect(agent.status).toBe("hibernating");
      expect(agent.currentVmId).toBeNull();
      expect(agent.latestCommitId).toBeNull();
      expect(agent.commitHistory).toEqual([]);
      expect(agent.sessionsCompleted).toBe(0);
      expect(agent.tasksCompleted).toBe(0);
      expect(agent.reportsPublished).toBe(0);
      expect(agent.notableEvents).toEqual([]);
      expect(agent.tags).toEqual([]);
      expect(agent.trustLevel).toBe("basic");
      expect(agent.totalTokensUsed).toBe(0);
      expect(agent.specializations).toEqual([]);
      expect(agent.createdAt).toBeTruthy();
      expect(agent.updatedAt).toBeTruthy();
    });

    it("creates an agent with all fields", () => {
      const agent = store.createAgent({
        name: "ariel",
        displayName: "Ariel",
        persona: "researcher",
        status: "awake",
        currentVmId: "vm-123",
        tags: ["research", "deep-dive"],
        trustLevel: "elevated",
        specializations: ["code-review", "architecture"],
      });
      expect(agent.displayName).toBe("Ariel");
      expect(agent.status).toBe("awake");
      expect(agent.currentVmId).toBe("vm-123");
      expect(agent.tags).toEqual(["research", "deep-dive"]);
      expect(agent.trustLevel).toBe("elevated");
      expect(agent.specializations).toEqual(["code-review", "architecture"]);
    });

    it("rejects missing name", () => {
      expect(() => store.createAgent({ name: "", persona: "x" })).toThrow(ValidationError);
    });

    it("rejects invalid name format", () => {
      expect(() => store.createAgent({ name: "BAD NAME", persona: "x" })).toThrow("lowercase");
      expect(() => store.createAgent({ name: "123start", persona: "x" })).toThrow("lowercase");
    });

    it("rejects missing persona", () => {
      expect(() => store.createAgent({ name: "test", persona: "" })).toThrow(ValidationError);
    });

    it("rejects invalid status", () => {
      expect(() => store.createAgent({ name: "test", persona: "x", status: "invalid" as any })).toThrow("invalid status");
    });

    it("rejects invalid trustLevel", () => {
      expect(() => store.createAgent({ name: "test", persona: "x", trustLevel: "supreme" as any })).toThrow("invalid trustLevel");
    });

    it("rejects duplicate names", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      expect(() => store.createAgent({ name: "puck", persona: "worker" })).toThrow(ConflictError);
    });
  });

  describe("getAgent", () => {
    it("returns an existing agent", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      const agent = store.getAgent("puck");
      expect(agent.name).toBe("puck");
    });

    it("throws NotFoundError for missing agent", () => {
      expect(() => store.getAgent("nobody")).toThrow(NotFoundError);
    });
  });

  describe("listAgents", () => {
    beforeEach(() => {
      store.createAgent({ name: "puck", persona: "orchestrator", status: "awake", tags: ["core"] });
      store.createAgent({ name: "ariel", persona: "researcher", tags: ["research"] });
      store.createAgent({ name: "caliban", persona: "worker", tags: ["core"] });
    });

    it("lists all agents", () => {
      expect(store.listAgents()).toHaveLength(3);
    });

    it("filters by status", () => {
      expect(store.listAgents({ status: "awake" })).toHaveLength(1);
      expect(store.listAgents({ status: "hibernating" })).toHaveLength(2);
    });

    it("filters by persona", () => {
      expect(store.listAgents({ persona: "orchestrator" })).toHaveLength(1);
    });

    it("filters by tag", () => {
      expect(store.listAgents({ tag: "core" })).toHaveLength(2);
      expect(store.listAgents({ tag: "research" })).toHaveLength(1);
    });
  });

  describe("updateAgent", () => {
    it("updates fields", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      const updated = store.updateAgent("puck", {
        displayName: "Puck the Trickster",
        trustLevel: "core",
        sessionsCompleted: 5,
        totalTokensUsed: 100000,
      });
      expect(updated.displayName).toBe("Puck the Trickster");
      expect(updated.trustLevel).toBe("core");
      expect(updated.sessionsCompleted).toBe(5);
      expect(updated.totalTokensUsed).toBe(100000);
    });

    it("throws NotFoundError for missing agent", () => {
      expect(() => store.updateAgent("nobody", { displayName: "x" })).toThrow(NotFoundError);
    });

    it("rejects invalid status", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      expect(() => store.updateAgent("puck", { status: "bogus" as any })).toThrow("invalid status");
    });
  });

  describe("hibernate", () => {
    it("puts an awake agent to sleep", () => {
      store.createAgent({ name: "puck", persona: "orchestrator", status: "awake", currentVmId: "vm-1" });
      const agent = store.hibernate("puck", {
        commitId: "commit-abc",
        vmId: "vm-1",
        reason: "task complete",
        summary: "Finished board migration",
      });
      expect(agent.status).toBe("hibernating");
      expect(agent.currentVmId).toBeNull();
      expect(agent.latestCommitId).toBe("commit-abc");
      expect(agent.commitHistory).toHaveLength(1);
      expect(agent.commitHistory[0].reason).toBe("task complete");
    });

    it("rejects hibernating a retired agent", () => {
      store.createAgent({ name: "old", persona: "worker" });
      store.retire("old");
      expect(() => store.hibernate("old", { commitId: "x" })).toThrow("retired");
    });

    it("requires commitId", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      expect(() => store.hibernate("puck", { commitId: "" })).toThrow("commitId");
    });
  });

  describe("wake", () => {
    it("wakes a hibernating agent", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      const agent = store.wake("puck", { vmId: "vm-new", briefing: "You have a new task" });
      expect(agent.status).toBe("awake");
      expect(agent.currentVmId).toBe("vm-new");
      expect(agent.briefing).toBe("You have a new task");
    });

    it("rejects waking a retired agent", () => {
      store.createAgent({ name: "old", persona: "worker" });
      store.retire("old");
      expect(() => store.wake("old", { vmId: "vm-1" })).toThrow("retired");
    });

    it("requires vmId", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      expect(() => store.wake("puck", { vmId: "" })).toThrow("vmId");
    });
  });

  describe("retire", () => {
    it("retires an agent", () => {
      store.createAgent({ name: "puck", persona: "orchestrator", status: "awake", currentVmId: "vm-1" });
      const agent = store.retire("puck");
      expect(agent.status).toBe("retired");
      expect(agent.currentVmId).toBeNull();
    });
  });

  describe("addEvent", () => {
    it("adds a notable event", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      const agent = store.addEvent("puck", {
        event: "Named himself Puck on Valentine's Day 2026",
        metadata: { holiday: "valentine" },
      });
      expect(agent.notableEvents).toHaveLength(1);
      expect(agent.notableEvents[0].event).toBe("Named himself Puck on Valentine's Day 2026");
      expect(agent.notableEvents[0].metadata).toEqual({ holiday: "valentine" });
    });

    it("requires event text", () => {
      store.createAgent({ name: "puck", persona: "orchestrator" });
      expect(() => store.addEvent("puck", { event: "" })).toThrow("event is required");
    });
  });

  describe("getHistory", () => {
    it("returns commit history", () => {
      store.createAgent({ name: "puck", persona: "orchestrator", status: "awake" });
      store.hibernate("puck", { commitId: "c1", reason: "r1", summary: "s1" });
      store.wake("puck", { vmId: "vm-2" });
      store.hibernate("puck", { commitId: "c2", reason: "r2", summary: "s2" });

      const history = store.getHistory("puck");
      expect(history).toHaveLength(2);
      expect(history[0].commitId).toBe("c1");
      expect(history[1].commitId).toBe("c2");
    });
  });

  describe("composeBriefing", () => {
    it("composes a wake-up briefing", () => {
      store.createAgent({
        name: "puck",
        displayName: "Puck",
        persona: "orchestrator",
        specializations: ["swarm-coordination"],
      });
      store.addEvent("puck", { event: "Named himself Puck on Valentine's Day 2026" });
      store.updateAgent("puck", {
        sessionsCompleted: 3,
        tasksCompleted: 12,
        briefing: "You are the master orchestrator.",
      });

      const briefing = store.composeBriefing("puck");
      expect(briefing).toContain("Welcome back, Puck");
      expect(briefing).toContain("orchestrator");
      expect(briefing).toContain("swarm-coordination");
      expect(briefing).toContain("Sessions completed: 3");
      expect(briefing).toContain("Tasks completed: 12");
      expect(briefing).toContain("Named himself Puck");
      expect(briefing).toContain("master orchestrator");
      expect(briefing).toContain("Cryochamber thaw complete");
    });
  });

  describe("persistence", () => {
    it("persists and reloads agents", () => {
      store.createAgent({ name: "puck", persona: "orchestrator", status: "awake" });
      store.addEvent("puck", { event: "test event" });
      store.flush();

      const store2 = new CryoStore(TEST_FILE);
      const agent = store2.getAgent("puck");
      expect(agent.name).toBe("puck");
      expect(agent.status).toBe("awake");
      expect(agent.notableEvents).toHaveLength(1);
    });
  });
});
