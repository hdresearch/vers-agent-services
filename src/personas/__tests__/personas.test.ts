import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersonaStore, NotFoundError, ValidationError } from "../store.js";
import { SEED_PERSONAS } from "../seed.js";

// --- Store unit tests ---

describe("PersonaStore", () => {
  let store: PersonaStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "persona-test-"));
    filePath = join(tmpDir, "personas.json");
    store = new PersonaStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const validInput = {
    name: "test-agent",
    displayName: "Test Agent",
    description: "A test persona",
    systemPrompt: "You are a test agent.",
    author: "tester",
  };

  describe("createPersona", () => {
    it("creates a persona with defaults", () => {
      const p = store.createPersona(validInput);
      expect(p.name).toBe("test-agent");
      expect(p.displayName).toBe("Test Agent");
      expect(p.version).toBe(1);
      expect(p.traits).toEqual([]);
      expect(p.specializations).toEqual([]);
      expect(p.tags).toEqual([]);
      expect(p.deleted).toBe(false);
      expect(p.createdAt).toBeTruthy();
    });

    it("creates with all fields", () => {
      const p = store.createPersona({
        ...validInput,
        traits: ["smart"],
        specializations: ["coding"],
        tags: ["core"],
      });
      expect(p.traits).toEqual(["smart"]);
      expect(p.specializations).toEqual(["coding"]);
      expect(p.tags).toEqual(["core"]);
    });

    it("rejects invalid name", () => {
      expect(() => store.createPersona({ ...validInput, name: "" })).toThrow(ValidationError);
      expect(() => store.createPersona({ ...validInput, name: "AB" })).toThrow(ValidationError);
      expect(() => store.createPersona({ ...validInput, name: "has spaces" })).toThrow(ValidationError);
      expect(() => store.createPersona({ ...validInput, name: "1starts-with-number" })).toThrow(ValidationError);
    });

    it("rejects missing required fields", () => {
      expect(() => store.createPersona({ ...validInput, displayName: "" })).toThrow(ValidationError);
      expect(() => store.createPersona({ ...validInput, description: "" })).toThrow(ValidationError);
      expect(() => store.createPersona({ ...validInput, systemPrompt: "" })).toThrow(ValidationError);
      expect(() => store.createPersona({ ...validInput, author: "" })).toThrow(ValidationError);
    });

    it("rejects duplicate name", () => {
      store.createPersona(validInput);
      expect(() => store.createPersona(validInput)).toThrow(ValidationError);
    });

    it("allows re-creating a deleted persona", () => {
      store.createPersona(validInput);
      store.deletePersona("test-agent");
      const p = store.createPersona(validInput);
      expect(p.deleted).toBe(false);
      expect(p.version).toBe(1);
    });

    it("validates parentPersona exists", () => {
      expect(() =>
        store.createPersona({ ...validInput, parentPersona: "nonexistent" })
      ).toThrow(ValidationError);
    });

    it("creates with valid parentPersona", () => {
      store.createPersona(validInput);
      const child = store.createPersona({
        ...validInput,
        name: "child-agent",
        parentPersona: "test-agent",
      });
      expect(child.parentPersona).toBe("test-agent");
    });
  });

  describe("getPersona", () => {
    it("returns persona by name", () => {
      store.createPersona(validInput);
      const p = store.getPersona("test-agent");
      expect(p).toBeDefined();
      expect(p!.name).toBe("test-agent");
    });

    it("returns undefined for unknown name", () => {
      expect(store.getPersona("nonexistent")).toBeUndefined();
    });

    it("returns undefined for deleted persona", () => {
      store.createPersona(validInput);
      store.deletePersona("test-agent");
      expect(store.getPersona("test-agent")).toBeUndefined();
    });
  });

  describe("listPersonas", () => {
    beforeEach(() => {
      store.createPersona({ ...validInput, name: "agent-aaa", tags: ["core"], author: "alice" });
      store.createPersona({
        ...validInput,
        name: "agent-bbb",
        tags: ["util"],
        author: "bob",
        specializations: ["coding"],
      });
      store.createPersona({ ...validInput, name: "agent-ccc", tags: ["core", "util"], author: "alice" });
    });

    it("lists all personas", () => {
      expect(store.listPersonas()).toHaveLength(3);
    });

    it("filters by tag", () => {
      expect(store.listPersonas({ tag: "core" })).toHaveLength(2);
    });

    it("filters by author", () => {
      expect(store.listPersonas({ author: "bob" })).toHaveLength(1);
    });

    it("filters by specialization", () => {
      expect(store.listPersonas({ specialization: "coding" })).toHaveLength(1);
    });

    it("excludes deleted by default", () => {
      store.deletePersona("agent-aaa");
      expect(store.listPersonas()).toHaveLength(2);
    });

    it("includes deleted when requested", () => {
      store.deletePersona("agent-aaa");
      expect(store.listPersonas({ includeDeleted: true })).toHaveLength(3);
    });

    it("sorts alphabetically", () => {
      const names = store.listPersonas().map((p) => p.name);
      expect(names).toEqual(["agent-aaa", "agent-bbb", "agent-ccc"]);
    });
  });

  describe("updatePersona", () => {
    it("updates fields and bumps version", async () => {
      store.createPersona(validInput);
      await new Promise((r) => setTimeout(r, 5));
      const updated = store.updatePersona("test-agent", {
        displayName: "Updated Agent",
        traits: ["new-trait"],
      });
      expect(updated.displayName).toBe("Updated Agent");
      expect(updated.traits).toEqual(["new-trait"]);
      expect(updated.version).toBe(2);
      expect(updated.updatedAt).not.toBe(updated.createdAt);
    });

    it("throws NotFoundError for unknown persona", () => {
      expect(() => store.updatePersona("nope", { displayName: "X" })).toThrow(NotFoundError);
    });

    it("throws NotFoundError for deleted persona", () => {
      store.createPersona(validInput);
      store.deletePersona("test-agent");
      expect(() => store.updatePersona("test-agent", { displayName: "X" })).toThrow(NotFoundError);
    });

    it("rejects empty displayName", () => {
      store.createPersona(validInput);
      expect(() => store.updatePersona("test-agent", { displayName: "" })).toThrow(ValidationError);
    });

    it("validates parentPersona", () => {
      store.createPersona(validInput);
      expect(() =>
        store.updatePersona("test-agent", { parentPersona: "nonexistent" })
      ).toThrow(ValidationError);
    });

    it("rejects self-referencing parentPersona", () => {
      store.createPersona(validInput);
      expect(() =>
        store.updatePersona("test-agent", { parentPersona: "test-agent" })
      ).toThrow(ValidationError);
    });

    it("clears parentPersona with null", () => {
      store.createPersona(validInput);
      store.createPersona({ ...validInput, name: "child-agent", parentPersona: "test-agent" });
      const updated = store.updatePersona("child-agent", { parentPersona: null });
      expect(updated.parentPersona).toBeUndefined();
    });
  });

  describe("deletePersona", () => {
    it("soft-deletes persona", () => {
      store.createPersona(validInput);
      expect(store.deletePersona("test-agent")).toBe(true);
      // Direct map check via list with includeDeleted
      const all = store.listPersonas({ includeDeleted: true });
      expect(all[0].deleted).toBe(true);
    });

    it("returns false for unknown persona", () => {
      expect(store.deletePersona("nope")).toBe(false);
    });

    it("returns false for already-deleted persona", () => {
      store.createPersona(validInput);
      store.deletePersona("test-agent");
      expect(store.deletePersona("test-agent")).toBe(false);
    });
  });

  describe("getVersions", () => {
    it("returns version history", () => {
      store.createPersona(validInput);
      store.updatePersona("test-agent", { displayName: "V2" });
      store.updatePersona("test-agent", { displayName: "V3" });
      const versions = store.getVersions("test-agent");
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(1);
      expect(versions[2].version).toBe(3);
      expect(versions[2].snapshot.displayName).toBe("V3");
    });

    it("throws NotFoundError for unknown persona", () => {
      expect(() => store.getVersions("nope")).toThrow(NotFoundError);
    });
  });

  describe("renderPrompt", () => {
    it("renders simple prompt", () => {
      store.createPersona(validInput);
      const result = store.renderPrompt("test-agent");
      expect(result.prompt).toBe("You are a test agent.");
      expect(result.chain).toEqual(["test-agent"]);
    });

    it("renders inherited prompt chain", () => {
      store.createPersona({
        ...validInput,
        name: "base-agent",
        systemPrompt: "Base instructions.",
        traits: ["base-trait"],
        specializations: ["base-spec"],
      });
      store.createPersona({
        ...validInput,
        name: "derived-agent",
        systemPrompt: "Derived instructions.",
        traits: ["derived-trait"],
        specializations: ["derived-spec"],
        parentPersona: "base-agent",
      });
      const result = store.renderPrompt("derived-agent");
      expect(result.prompt).toBe("Base instructions.\n\nDerived instructions.");
      expect(result.chain).toEqual(["base-agent", "derived-agent"]);
      expect(result.traits).toEqual(["base-trait", "derived-trait"]);
      expect(result.specializations).toEqual(["base-spec", "derived-spec"]);
    });

    it("renders multi-level inheritance", () => {
      store.createPersona({ ...validInput, name: "level-one", systemPrompt: "L1" });
      store.createPersona({ ...validInput, name: "level-two", systemPrompt: "L2", parentPersona: "level-one" });
      store.createPersona({ ...validInput, name: "level-three", systemPrompt: "L3", parentPersona: "level-two" });
      const result = store.renderPrompt("level-three");
      expect(result.prompt).toBe("L1\n\nL2\n\nL3");
      expect(result.chain).toEqual(["level-one", "level-two", "level-three"]);
    });

    it("deduplicates traits across chain", () => {
      store.createPersona({ ...validInput, name: "parent-agt", traits: ["shared", "parent-only"] });
      store.createPersona({
        ...validInput,
        name: "child-agt",
        traits: ["shared", "child-only"],
        parentPersona: "parent-agt",
      });
      const result = store.renderPrompt("child-agt");
      expect(result.traits).toEqual(["shared", "parent-only", "child-only"]);
    });

    it("throws NotFoundError for unknown persona", () => {
      expect(() => store.renderPrompt("nope")).toThrow(NotFoundError);
    });

    it("throws NotFoundError for deleted persona", () => {
      store.createPersona(validInput);
      store.deletePersona("test-agent");
      expect(() => store.renderPrompt("test-agent")).toThrow(NotFoundError);
    });
  });

  describe("persistence", () => {
    it("persists and reloads", () => {
      store.createPersona(validInput);
      store.updatePersona("test-agent", { displayName: "Updated" });
      store.flush();

      const store2 = new PersonaStore(filePath);
      const loaded = store2.getPersona("test-agent");
      expect(loaded).toBeDefined();
      expect(loaded!.displayName).toBe("Updated");
      expect(loaded!.version).toBe(2);

      const versions = store2.getVersions("test-agent");
      expect(versions).toHaveLength(2);
    });

    it("writes valid JSON", () => {
      store.createPersona(validInput);
      store.flush();
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      expect(data.personas).toHaveLength(1);
      expect(data.versions["test-agent"]).toHaveLength(1);
    });

    it("starts fresh if file is missing", () => {
      const fresh = new PersonaStore(join(tmpDir, "nonexistent.json"));
      expect(fresh.listPersonas()).toHaveLength(0);
    });
  });

  describe("seed personas", () => {
    it("all seed personas are valid and create successfully", () => {
      for (const seed of SEED_PERSONAS) {
        const p = store.createPersona(seed);
        expect(p.name).toBe(seed.name);
        expect(p.version).toBe(1);
      }
      expect(store.listPersonas()).toHaveLength(SEED_PERSONAS.length);
    });

    it("seed covers expected names", () => {
      for (const seed of SEED_PERSONAS) {
        store.createPersona(seed);
      }
      const names = store.listPersonas().map((p) => p.name);
      expect(names).toContain("orchestrator");
      expect(names).toContain("architect");
      expect(names).toContain("lieutenant");
      expect(names).toContain("reviewer");
      expect(names).toContain("researcher");
      expect(names).toContain("biographer");
    });
  });
});

// --- Route integration tests ---

describe("Persona Routes", () => {
  let app: Hono;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "persona-route-test-"));
    const { personaRoutes } = await import("../routes.js");
    app = new Hono();
    app.route("/personas", personaRoutes);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const json = (body: any) => ({
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const validBody = {
    name: "route-test",
    displayName: "Route Test",
    description: "Test persona",
    systemPrompt: "You are a test.",
    author: "tester",
  };

  it("POST /personas — creates persona", async () => {
    const res = await app.request("/personas", json(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("route-test");
    expect(body.version).toBe(1);
  });

  it("POST /personas — 400 on invalid input", async () => {
    const res = await app.request("/personas", json({ name: "" }));
    expect(res.status).toBe(400);
  });

  it("GET /personas — lists personas", async () => {
    await app.request("/personas", json(validBody));
    await app.request("/personas", json({ ...validBody, name: "second-test" }));
    const res = await app.request("/personas");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it("GET /personas?tag=x — filters by tag", async () => {
    await app.request("/personas", json({ ...validBody, name: "tagged-one", tags: ["special"] }));
    await app.request("/personas", json({ ...validBody, name: "tagged-two", tags: ["other"] }));
    const res = await app.request("/personas?tag=special");
    const body = await res.json();
    const names = body.personas.map((p: any) => p.name);
    expect(names).toContain("tagged-one");
  });

  it("GET /personas/:name — returns persona", async () => {
    await app.request("/personas", json(validBody));
    const res = await app.request("/personas/route-test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("route-test");
  });

  it("GET /personas/:name — 404 for unknown", async () => {
    const res = await app.request("/personas/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PATCH /personas/:name — updates and bumps version", async () => {
    await app.request("/personas", json(validBody));
    const res = await app.request("/personas/route-test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Updated Name", traits: ["new"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Updated Name");
    expect(body.version).toBe(2);
  });

  it("PATCH /personas/:name — 404 for unknown", async () => {
    const res = await app.request("/personas/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "X" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /personas/:name — soft deletes", async () => {
    await app.request("/personas", json(validBody));
    const res = await app.request("/personas/route-test", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    // Verify it's gone from GET
    const getRes = await app.request("/personas/route-test");
    expect(getRes.status).toBe(404);
  });

  it("DELETE /personas/:name — 404 for unknown", async () => {
    const res = await app.request("/personas/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /personas/:name/versions — returns history", async () => {
    await app.request("/personas", json(validBody));
    await app.request("/personas/route-test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "V2" }),
    });
    const res = await app.request("/personas/route-test/versions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
  });

  it("GET /personas/:name/versions — 404 for unknown", async () => {
    const res = await app.request("/personas/nonexistent/versions");
    expect(res.status).toBe(404);
  });

  it("GET /personas/:name/prompt — renders prompt", async () => {
    await app.request("/personas", json(validBody));
    const res = await app.request("/personas/route-test/prompt");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBe("You are a test.");
    expect(body.chain).toEqual(["route-test"]);
  });

  it("GET /personas/:name/prompt — 404 for unknown", async () => {
    const res = await app.request("/personas/nonexistent/prompt");
    expect(res.status).toBe(404);
  });
});
