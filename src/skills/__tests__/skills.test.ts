import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SkillStore, ExtensionStore, ManifestStore } from "../store.js";
import { skillStore, extensionStore, manifestStore, skillsRoutes } from "../routes.js";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";

const app = new Hono();
app.route("/skills", skillsRoutes);

function req(path: string, init?: RequestInit) {
  return app.request(`http://localhost/skills${path}`, init);
}

function jsonPost(path: string, body: Record<string, unknown>) {
  return req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonPatch(path: string, body: Record<string, unknown>) {
  return req(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const sampleSkill = {
  name: "test-skill",
  description: "A test skill",
  content: "# Test Skill\n\nDo the thing.",
  publishedBy: "tester",
  tags: ["testing"],
};

const sampleExtension = {
  name: "test-ext",
  description: "A test extension",
  content: 'export function activate() { return "hi"; }',
  publishedBy: "tester",
};

describe("SkillHub Service", () => {
  beforeEach(() => {
    skillStore.clear();
    skillStore.flush();
    extensionStore.clear();
    extensionStore.flush();
    manifestStore.clear();
    manifestStore.flush();
  });

  // ─── Skills CRUD ─────────────────────────────────────────

  describe("POST /skills/items — Publish skill", () => {
    it("creates a new skill and returns 201", async () => {
      const res = await jsonPost("/items", sampleSkill);
      expect(res.status).toBe(201);
      const skill = await res.json();
      expect(skill.id).toBeDefined();
      expect(skill.name).toBe("test-skill");
      expect(skill.version).toBe(1);
      expect(skill.description).toBe("A test skill");
      expect(skill.content).toContain("# Test Skill");
      expect(skill.publishedBy).toBe("tester");
      expect(skill.tags).toEqual(["testing"]);
      expect(skill.enabled).toBe(true);
      expect(skill.publishedAt).toBeDefined();
      expect(skill.updatedAt).toBeDefined();
    });

    it("upserts — second publish bumps version", async () => {
      await jsonPost("/items", sampleSkill);
      const res = await jsonPost("/items", { ...sampleSkill, content: "# Updated" });
      expect(res.status).toBe(201);
      const skill = await res.json();
      expect(skill.version).toBe(2);
      expect(skill.content).toBe("# Updated");
    });

    it("rejects missing name", async () => {
      const res = await jsonPost("/items", { ...sampleSkill, name: "" });
      expect(res.status).toBe(400);
    });

    it("rejects missing content", async () => {
      const res = await jsonPost("/items", { ...sampleSkill, content: "" });
      expect(res.status).toBe(400);
    });

    it("rejects missing publishedBy", async () => {
      const res = await jsonPost("/items", { ...sampleSkill, publishedBy: "" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await req("/items", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /skills/items — List skills", () => {
    it("returns empty list initially", async () => {
      const res = await req("/items");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skills).toEqual([]);
      expect(data.count).toBe(0);
    });

    it("returns published skills", async () => {
      await jsonPost("/items", sampleSkill);
      await jsonPost("/items", { ...sampleSkill, name: "another", description: "Another skill" });
      const res = await req("/items");
      const data = await res.json();
      expect(data.count).toBe(2);
    });

    it("filters by tag", async () => {
      await jsonPost("/items", { ...sampleSkill, tags: ["infra"] });
      await jsonPost("/items", {
        ...sampleSkill,
        name: "other",
        description: "Other",
        tags: ["coord"],
      });
      const res = await req("/items?tag=infra");
      const data = await res.json();
      expect(data.count).toBe(1);
      expect(data.skills[0].name).toBe("test-skill");
    });

    it("filters by enabled", async () => {
      await jsonPost("/items", sampleSkill);
      await jsonPost("/items", {
        ...sampleSkill,
        name: "disabled",
        description: "Disabled",
        enabled: false,
      });
      const res = await req("/items?enabled=true");
      const data = await res.json();
      expect(data.count).toBe(1);
      expect(data.skills[0].name).toBe("test-skill");
    });
  });

  describe("GET /skills/items/:name — Get skill", () => {
    it("returns a skill by name", async () => {
      await jsonPost("/items", sampleSkill);
      const res = await req("/items/test-skill");
      expect(res.status).toBe(200);
      const skill = await res.json();
      expect(skill.name).toBe("test-skill");
      expect(skill.content).toContain("# Test Skill");
    });

    it("returns 404 for unknown skill", async () => {
      const res = await req("/items/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /skills/items/:name — Patch skill", () => {
    it("updates tags", async () => {
      await jsonPost("/items", sampleSkill);
      const res = await jsonPatch("/items/test-skill", { tags: ["updated", "tags"] });
      expect(res.status).toBe(200);
      const skill = await res.json();
      expect(skill.tags).toEqual(["updated", "tags"]);
    });

    it("disables a skill", async () => {
      await jsonPost("/items", sampleSkill);
      const res = await jsonPatch("/items/test-skill", { enabled: false });
      expect(res.status).toBe(200);
      const skill = await res.json();
      expect(skill.enabled).toBe(false);
    });

    it("returns 404 for unknown skill", async () => {
      const res = await jsonPatch("/items/nonexistent", { enabled: false });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /skills/items/:name — Delete skill", () => {
    it("deletes a skill", async () => {
      await jsonPost("/items", sampleSkill);
      const res = await req("/items/test-skill", { method: "DELETE" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deleted).toBe(true);

      // Verify it's gone
      const getRes = await req("/items/test-skill");
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for unknown skill", async () => {
      const res = await req("/items/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Extensions CRUD ────────────────────────────────────

  describe("POST /skills/extensions — Publish extension", () => {
    it("creates a new extension and returns 201", async () => {
      const res = await jsonPost("/extensions", sampleExtension);
      expect(res.status).toBe(201);
      const ext = await res.json();
      expect(ext.id).toBeDefined();
      expect(ext.name).toBe("test-ext");
      expect(ext.version).toBe(1);
      expect(ext.enabled).toBe(true);
    });

    it("upserts on second publish", async () => {
      await jsonPost("/extensions", sampleExtension);
      const res = await jsonPost("/extensions", { ...sampleExtension, content: "// v2" });
      const ext = await res.json();
      expect(ext.version).toBe(2);
      expect(ext.content).toBe("// v2");
    });

    it("rejects missing name", async () => {
      const res = await jsonPost("/extensions", { ...sampleExtension, name: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /skills/extensions — List extensions", () => {
    it("returns empty list initially", async () => {
      const res = await req("/extensions");
      const data = await res.json();
      expect(data.extensions).toEqual([]);
      expect(data.count).toBe(0);
    });

    it("returns published extensions", async () => {
      await jsonPost("/extensions", sampleExtension);
      const res = await req("/extensions");
      const data = await res.json();
      expect(data.count).toBe(1);
    });
  });

  describe("GET /skills/extensions/:name — Get extension", () => {
    it("returns extension by name", async () => {
      await jsonPost("/extensions", sampleExtension);
      const res = await req("/extensions/test-ext");
      expect(res.status).toBe(200);
      const ext = await res.json();
      expect(ext.name).toBe("test-ext");
    });

    it("returns 404 for unknown", async () => {
      const res = await req("/extensions/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /skills/extensions/:name — Delete extension", () => {
    it("deletes an extension", async () => {
      await jsonPost("/extensions", sampleExtension);
      const res = await req("/extensions/test-ext", { method: "DELETE" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for unknown", async () => {
      const res = await req("/extensions/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Sync Protocol ──────────────────────────────────────

  describe("GET /skills/manifest — Current manifest", () => {
    it("returns manifest of enabled skills and extensions", async () => {
      await jsonPost("/items", sampleSkill);
      await jsonPost("/items", {
        ...sampleSkill,
        name: "disabled-skill",
        description: "Disabled",
        enabled: false,
      });
      await jsonPost("/extensions", sampleExtension);

      const res = await req("/manifest");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0]).toEqual({ name: "test-skill", version: 1 });
      expect(data.extensions).toHaveLength(1);
      expect(data.extensions[0]).toEqual({ name: "test-ext", version: 1 });
    });
  });

  describe("POST /skills/sync — Agent sync", () => {
    it("returns install updates for new skills", async () => {
      await jsonPost("/items", sampleSkill);
      await jsonPost("/extensions", sampleExtension);

      const res = await jsonPost("/sync", {
        agentId: "agent-1",
        skills: [],
        extensions: [],
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.updates).toHaveLength(2);
      expect(data.updates).toContainEqual({
        type: "skill",
        name: "test-skill",
        version: 1,
        action: "install",
      });
      expect(data.updates).toContainEqual({
        type: "extension",
        name: "test-ext",
        version: 1,
        action: "install",
      });
    });

    it("returns update action for outdated versions", async () => {
      await jsonPost("/items", sampleSkill);
      await jsonPost("/items", { ...sampleSkill, content: "# v2" }); // version 2

      const res = await jsonPost("/sync", {
        agentId: "agent-1",
        skills: [{ name: "test-skill", version: 1 }],
        extensions: [],
      });
      const data = await res.json();
      expect(data.updates).toHaveLength(1);
      expect(data.updates[0]).toEqual({
        type: "skill",
        name: "test-skill",
        version: 2,
        action: "update",
      });
    });

    it("returns remove action for skills no longer in hub", async () => {
      const res = await jsonPost("/sync", {
        agentId: "agent-1",
        skills: [{ name: "removed-skill", version: 1 }],
        extensions: [],
      });
      const data = await res.json();
      expect(data.updates).toHaveLength(1);
      expect(data.updates[0].action).toBe("remove");
      expect(data.updates[0].name).toBe("removed-skill");
    });

    it("returns empty updates when agent is current", async () => {
      await jsonPost("/items", sampleSkill);
      const res = await jsonPost("/sync", {
        agentId: "agent-1",
        skills: [{ name: "test-skill", version: 1 }],
        extensions: [],
      });
      const data = await res.json();
      expect(data.updates).toHaveLength(0);
    });

    it("rejects missing agentId", async () => {
      const res = await jsonPost("/sync", { skills: [], extensions: [] });
      expect(res.status).toBe(400);
    });
  });

  // ─── Agent Inventory ────────────────────────────────────

  describe("GET /skills/agents — Agent inventory", () => {
    it("returns empty list initially", async () => {
      const res = await req("/agents");
      const data = await res.json();
      expect(data.agents).toEqual([]);
    });

    it("returns agents after sync", async () => {
      await jsonPost("/sync", {
        agentId: "agent-1",
        vmId: "vm-abc",
        skills: [{ name: "board", version: 1 }],
        extensions: [],
      });

      const res = await req("/agents");
      const data = await res.json();
      expect(data.count).toBe(1);
      expect(data.agents[0].agentId).toBe("agent-1");
      expect(data.agents[0].vmId).toBe("vm-abc");
      expect(data.agents[0].skills).toEqual([{ name: "board", version: 1 }]);
    });
  });

  describe("GET /skills/agents/:agentId — Specific agent", () => {
    it("returns agent manifest", async () => {
      await jsonPost("/sync", {
        agentId: "agent-1",
        skills: [{ name: "board", version: 1 }],
        extensions: [{ name: "test-ext", version: 1 }],
      });

      const res = await req("/agents/agent-1");
      expect(res.status).toBe(200);
      const manifest = await res.json();
      expect(manifest.agentId).toBe("agent-1");
      expect(manifest.lastSync).toBeDefined();
    });

    it("returns 404 for unknown agent", async () => {
      const res = await req("/agents/unknown");
      expect(res.status).toBe(404);
    });
  });

  // ─── SSE Stream ──────────────────────────────────────────

  describe("GET /skills/stream — SSE change stream", () => {
    it("receives skill change events", async () => {
      const res = await req("/stream");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Publish a skill to trigger an event
      skillStore.publish({
        name: "streamed-skill",
        description: "A streamed skill",
        content: "# Stream test",
        publishedBy: "tester",
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes("streamed-skill")) break;
        }
      } finally {
        clearTimeout(timeout);
        reader.cancel();
      }

      expect(text).toContain("streamed-skill");
      expect(text).toContain('"action":"publish"');
    });

    it("replays events since a ULID", async () => {
      // Publish skills before connecting
      skillStore.publish({
        name: "s1",
        description: "First",
        content: "# 1",
        publishedBy: "t",
      });

      // Get the ULID of the first event
      const events = skillStore.allChangeEvents;
      const sinceId = events[0].id;

      // Publish another before connecting (will be replayed)
      skillStore.publish({
        name: "s2",
        description: "Second",
        content: "# 2",
        publishedBy: "t",
      });

      const res = await req(`/stream?since=${sinceId}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      // Publish a live event after connect to help flush the stream
      setTimeout(() => {
        skillStore.publish({
          name: "s3",
          description: "Third",
          content: "# 3",
          publishedBy: "t",
        });
      }, 100);

      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.includes("s2")) break;
        }
      } finally {
        clearTimeout(timeout);
        reader.cancel();
      }

      expect(text).toContain('"s2"');
    });
  });

  // ─── Store Persistence ──────────────────────────────────

  describe("SkillStore — Persistence", () => {
    const testFile = "data/test-skills.json";

    afterEach(() => {
      if (existsSync(testFile)) unlinkSync(testFile);
    });

    it("persists and reloads skills", () => {
      const store1 = new SkillStore(testFile);
      store1.publish({
        name: "persistent",
        description: "Persisted",
        content: "# Persist",
        publishedBy: "test",
      });
      store1.flush();

      const store2 = new SkillStore(testFile);
      const skill = store2.get("persistent");
      expect(skill).toBeDefined();
      expect(skill!.name).toBe("persistent");
      expect(skill!.version).toBe(1);
    });
  });

  describe("ExtensionStore — Persistence", () => {
    const testFile = "data/test-extensions.json";

    afterEach(() => {
      if (existsSync(testFile)) unlinkSync(testFile);
    });

    it("persists and reloads extensions", () => {
      const store1 = new ExtensionStore(testFile);
      store1.publish({
        name: "persistent-ext",
        description: "Persisted",
        content: "// code",
        publishedBy: "test",
      });
      store1.flush();

      const store2 = new ExtensionStore(testFile);
      const ext = store2.get("persistent-ext");
      expect(ext).toBeDefined();
      expect(ext!.name).toBe("persistent-ext");
    });
  });

  describe("ManifestStore — Persistence", () => {
    const testFile = "data/test-manifests.json";

    afterEach(() => {
      if (existsSync(testFile)) unlinkSync(testFile);
    });

    it("persists and reloads agent manifests", () => {
      const store1 = new ManifestStore(testFile);
      store1.sync(
        { agentId: "a1", skills: [{ name: "board", version: 1 }], extensions: [] },
        [],
        [],
      );
      store1.flush();

      const store2 = new ManifestStore(testFile);
      const manifest = store2.get("a1");
      expect(manifest).toBeDefined();
      expect(manifest!.agentId).toBe("a1");
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────

  describe("Edge cases", () => {
    it("version increments correctly across multiple updates", async () => {
      for (let i = 0; i < 5; i++) {
        await jsonPost("/items", { ...sampleSkill, content: `# v${i + 1}` });
      }
      const res = await req("/items/test-skill");
      const skill = await res.json();
      expect(skill.version).toBe(5);
    });

    it("extension version increments correctly", async () => {
      for (let i = 0; i < 3; i++) {
        await jsonPost("/extensions", { ...sampleExtension, content: `// v${i + 1}` });
      }
      const res = await req("/extensions/test-ext");
      const ext = await res.json();
      expect(ext.version).toBe(3);
    });

    it("disabled skills excluded from manifest", async () => {
      await jsonPost("/items", { ...sampleSkill, enabled: false });
      const res = await req("/manifest");
      const data = await res.json();
      expect(data.skills).toHaveLength(0);
    });

    it("sync handles mixed install/update/remove", async () => {
      // Hub has skill-a v2 and skill-b v1
      await jsonPost("/items", { ...sampleSkill, name: "skill-a", description: "A" });
      await jsonPost("/items", { ...sampleSkill, name: "skill-a", description: "A", content: "# v2" });
      await jsonPost("/items", { ...sampleSkill, name: "skill-b", description: "B" });

      const res = await jsonPost("/sync", {
        agentId: "agent-x",
        skills: [
          { name: "skill-a", version: 1 }, // outdated → update
          { name: "skill-c", version: 1 }, // not in hub → remove
        ],
        extensions: [],
      });
      const data = await res.json();
      const actions = data.updates.map((u: any) => `${u.name}:${u.action}`);
      expect(actions).toContain("skill-a:update");
      expect(actions).toContain("skill-b:install");
      expect(actions).toContain("skill-c:remove");
    });
  });
});
