import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProjectStore, ValidationError } from "../store.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "data/test-projects.db";

describe("ProjectStore", () => {
  let store: ProjectStore;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new ProjectStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_DB + "-wal")) unlinkSync(TEST_DB + "-wal");
    if (existsSync(TEST_DB + "-shm")) unlinkSync(TEST_DB + "-shm");
  });

  describe("create", () => {
    it("creates a project with all fields", () => {
      const p = store.create({
        name: "oil-camp",
        displayName: "Oil Camp",
        description: "Rust fleet engine",
        tags: ["oil", "rust"],
        matchers: {
          boardTags: ["oil-camp"],
          agents: ["rustacean"],
        },
      });

      expect(p.id).toBeTruthy();
      expect(p.name).toBe("oil-camp");
      expect(p.displayName).toBe("Oil Camp");
      expect(p.description).toBe("Rust fleet engine");
      expect(p.status).toBe("active");
      expect(p.tags).toEqual(["oil", "rust"]);
      expect(p.matchers.boardTags).toEqual(["oil-camp"]);
      expect(p.matchers.agents).toEqual(["rustacean"]);
      // Default matchers should be filled
      expect(p.matchers.feedPatterns).toEqual([]);
      expect(p.matchers.repos).toEqual([]);
    });

    it("requires name", () => {
      expect(() =>
        store.create({ name: "", displayName: "Test" }),
      ).toThrow(ValidationError);
    });

    it("requires displayName", () => {
      expect(() =>
        store.create({ name: "test", displayName: "" }),
      ).toThrow(ValidationError);
    });

    it("rejects duplicate names", () => {
      store.create({ name: "oil-camp", displayName: "Oil Camp" });
      expect(() =>
        store.create({ name: "oil-camp", displayName: "Oil Camp 2" }),
      ).toThrow(ValidationError);
    });

    it("validates status", () => {
      expect(() =>
        store.create({
          name: "test",
          displayName: "Test",
          status: "invalid" as any,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("get / getByName", () => {
    it("gets by id", () => {
      const created = store.create({
        name: "test",
        displayName: "Test",
      });
      const fetched = store.get(created.id);
      expect(fetched).toBeTruthy();
      expect(fetched!.name).toBe("test");
    });

    it("gets by name", () => {
      store.create({ name: "oil-camp", displayName: "Oil Camp" });
      const fetched = store.getByName("oil-camp");
      expect(fetched).toBeTruthy();
      expect(fetched!.displayName).toBe("Oil Camp");
    });

    it("returns null for missing", () => {
      expect(store.get("nonexistent")).toBeNull();
      expect(store.getByName("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    beforeEach(() => {
      store.create({
        name: "p1",
        displayName: "P1",
        status: "active",
        tags: ["a", "b"],
      });
      store.create({
        name: "p2",
        displayName: "P2",
        status: "paused",
        tags: ["b", "c"],
      });
      store.create({
        name: "p3",
        displayName: "P3",
        status: "complete",
        tags: ["a"],
      });
    });

    it("lists all projects", () => {
      const all = store.list();
      expect(all).toHaveLength(3);
    });

    it("filters by status", () => {
      const active = store.list({ status: "active" });
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("p1");
    });

    it("filters by tag", () => {
      const tagged = store.list({ tag: "b" });
      expect(tagged).toHaveLength(2);
    });
  });

  describe("update", () => {
    it("updates fields", () => {
      const p = store.create({ name: "test", displayName: "Test" });
      const updated = store.update(p.id, {
        displayName: "Updated",
        status: "paused",
        tags: ["new-tag"],
      });
      expect(updated!.displayName).toBe("Updated");
      expect(updated!.status).toBe("paused");
      expect(updated!.tags).toEqual(["new-tag"]);
    });

    it("merges matchers", () => {
      const p = store.create({
        name: "test",
        displayName: "Test",
        matchers: { boardTags: ["a"], agents: ["x"] },
      });
      const updated = store.update(p.id, {
        matchers: { agents: ["y", "z"] },
      });
      expect(updated!.matchers.boardTags).toEqual(["a"]); // preserved
      expect(updated!.matchers.agents).toEqual(["y", "z"]); // replaced
    });

    it("returns null for missing project", () => {
      expect(store.update("nonexistent", { status: "paused" })).toBeNull();
    });

    it("rejects duplicate name on update", () => {
      store.create({ name: "p1", displayName: "P1" });
      const p2 = store.create({ name: "p2", displayName: "P2" });
      expect(() => store.update(p2.id, { name: "p1" })).toThrow(
        ValidationError,
      );
    });
  });

  describe("delete", () => {
    it("deletes a project", () => {
      const p = store.create({ name: "test", displayName: "Test" });
      expect(store.delete(p.id)).toBe(true);
      expect(store.get(p.id)).toBeNull();
    });

    it("returns false for missing", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });
});
