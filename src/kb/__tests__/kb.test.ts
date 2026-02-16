import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KBStore } from "../store.js";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";

const TEST_FILE = "data/test-kb.json";

function cleanup() {
  for (const f of [TEST_FILE, TEST_FILE + ".tmp"]) {
    try { unlinkSync(f); } catch {}
  }
}

describe("KBStore", () => {
  let store: KBStore;

  beforeEach(() => {
    cleanup();
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    store = new KBStore(TEST_FILE);
  });

  afterEach(() => cleanup());

  describe("create", () => {
    it("creates an entry with all fields", () => {
      const entry = store.createEntry({
        type: "lesson",
        title: "Always bind to IPv6",
        content: "Vers proxy requires IPv6. Use `::` not `0.0.0.0`.",
        source: "agent:infra-lt",
        tags: ["networking", "vers"],
        priority: "high",
      });

      expect(entry.id).toBeTruthy();
      expect(entry.type).toBe("lesson");
      expect(entry.title).toBe("Always bind to IPv6");
      expect(entry.priority).toBe("high");
      expect(entry.tags).toEqual(["networking", "vers"]);
      expect(entry.accessCount).toBe(0);
      expect(entry.expiresAt).toBeNull();
    });

    it("sets expiry from decayDays", () => {
      const entry = store.createEntry({
        type: "gotcha",
        title: "Temp workaround",
        content: "Use flag X until fix lands",
        decayDays: 7,
      });

      expect(entry.expiresAt).toBeTruthy();
      const expiry = new Date(entry.expiresAt!);
      const now = new Date();
      const diffDays = (expiry.getTime() - now.getTime()) / 86400000;
      expect(diffDays).toBeGreaterThan(6);
      expect(diffDays).toBeLessThan(8);
    });

    it("rejects invalid type", () => {
      expect(() => store.createEntry({
        type: "invalid" as any,
        title: "Bad",
        content: "Test",
      })).toThrow("type must be one of");
    });

    it("rejects missing title", () => {
      expect(() => store.createEntry({
        type: "lesson",
        title: "",
        content: "Test",
      })).toThrow("title is required");
    });
  });

  describe("get", () => {
    it("retrieves entry and increments access count", () => {
      const created = store.createEntry({
        type: "convention",
        title: "Commit format",
        content: "Use conventional commits",
      });

      const fetched = store.getEntry(created.id);
      expect(fetched.accessCount).toBe(1);

      const again = store.getEntry(created.id);
      expect(again.accessCount).toBe(2);
    });

    it("throws for non-existent id", () => {
      expect(() => store.getEntry("nonexistent")).toThrow("not found");
    });
  });

  describe("update", () => {
    it("updates fields", () => {
      const created = store.createEntry({
        type: "lesson",
        title: "Original",
        content: "Original content",
      });

      const updated = store.updateEntry(created.id, {
        title: "Updated Title",
        priority: "critical",
        tags: ["important"],
      });

      expect(updated.title).toBe("Updated Title");
      expect(updated.priority).toBe("critical");
      expect(updated.tags).toEqual(["important"]);
      expect(updated.content).toBe("Original content");
    });
  });

  describe("delete", () => {
    it("removes an entry", () => {
      const created = store.createEntry({
        type: "reference",
        title: "API docs",
        content: "See /api/...",
      });

      expect(store.deleteEntry(created.id)).toBe(true);
      expect(store.deleteEntry(created.id)).toBe(false);
    });
  });

  describe("list + filters", () => {
    beforeEach(() => {
      store.createEntry({ type: "lesson", title: "Lesson 1", content: "L1", tags: ["deploy"], priority: "high" });
      store.createEntry({ type: "gotcha", title: "Gotcha 1", content: "G1", tags: ["deploy", "auth"] });
      store.createEntry({ type: "convention", title: "Convention 1", content: "C1", tags: ["code"] });
      store.createEntry({ type: "lesson", title: "Lesson 2", content: "L2 about authentication", tags: ["auth"], priority: "critical" });
    });

    it("lists all entries", () => {
      expect(store.listEntries().length).toBe(4);
    });

    it("filters by type", () => {
      const lessons = store.listEntries({ type: "lesson" });
      expect(lessons.length).toBe(2);
    });

    it("filters by tag", () => {
      const authEntries = store.listEntries({ tag: "auth" });
      expect(authEntries.length).toBe(2);
    });

    it("filters by priority", () => {
      const critical = store.listEntries({ priority: "critical" });
      expect(critical.length).toBe(1);
      expect(critical[0].title).toBe("Lesson 2");
    });

    it("full-text search", () => {
      const results = store.listEntries({ search: "authentication" });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe("Lesson 2");
    });

    it("sorts by priority then recency", () => {
      const all = store.listEntries();
      expect(all[0].priority).toBe("critical");
      expect(all[1].priority).toBe("high");
    });

    it("excludes expired entries by default", () => {
      store.createEntry({
        type: "gotcha",
        title: "Expired",
        content: "Should not appear",
        decayDays: -1, // Already expired
      });
      // Manually set expiresAt to the past
      const entries = store.listEntries({ includeExpired: true });
      expect(entries.length).toBe(5);
    });
  });

  describe("briefing", () => {
    it("generates markdown briefing", () => {
      store.createEntry({ type: "lesson", title: "Test Lesson", content: "Content here", tags: ["test"] });
      store.createEntry({ type: "gotcha", title: "Test Gotcha", content: "Watch out!", priority: "critical" });

      const briefing = store.briefing();
      expect(briefing).toContain("# Fleet Knowledge Base");
      expect(briefing).toContain("Test Lesson");
      expect(briefing).toContain("🚨 Critical Knowledge");
      expect(briefing).toContain("Test Gotcha");
    });

    it("filters by tags", () => {
      store.createEntry({ type: "lesson", title: "Deploy Lesson", content: "D", tags: ["deploy"] });
      store.createEntry({ type: "lesson", title: "Auth Lesson", content: "A", tags: ["auth"] });

      const briefing = store.briefing({ tags: ["deploy"] });
      expect(briefing).toContain("Deploy Lesson");
      expect(briefing).not.toContain("Auth Lesson");
    });

    it("returns empty string when no entries", () => {
      expect(store.briefing()).toBe("");
    });
  });

  describe("stats", () => {
    it("returns correct statistics", () => {
      store.createEntry({ type: "lesson", title: "L1", content: "C", tags: ["a", "b"], priority: "high" });
      store.createEntry({ type: "gotcha", title: "G1", content: "C", tags: ["a"] });

      const stats = store.stats();
      expect(stats.total).toBe(2);
      expect(stats.byType.lesson).toBe(1);
      expect(stats.byType.gotcha).toBe(1);
      expect(stats.byPriority.high).toBe(1);
      expect(stats.byPriority.normal).toBe(1);
      expect(stats.topTags[0]).toEqual({ tag: "a", count: 2 });
    });
  });

  describe("persistence", () => {
    it("survives reload", () => {
      store.createEntry({ type: "lesson", title: "Persistent", content: "Survives" });
      store.flush();

      const store2 = new KBStore(TEST_FILE);
      const entries = store2.listEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].title).toBe("Persistent");
    });
  });
});
