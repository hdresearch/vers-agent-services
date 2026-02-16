import { describe, it, expect, beforeEach } from "vitest";
import { KBStore, ValidationError, NotFoundError, type EntryType } from "../kb/store.js";

describe("KBStore", () => {
  let store: KBStore;

  beforeEach(() => {
    // Use a temp file that won't collide
    store = new KBStore(`/tmp/kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  describe("createEntry", () => {
    it("creates a warning entry with defaults", () => {
      const entry = store.createEntry({
        type: "warning",
        content: "Never use pkill on agent-services",
        source: "infra-deploy skill",
        tags: ["deploy", "infra"],
      });

      expect(entry.id).toBeTruthy();
      expect(entry.type).toBe("warning");
      expect(entry.content).toBe("Never use pkill on agent-services");
      expect(entry.confidence).toBe(5);
      expect(entry.decayDays).toBe(7); // warning default
      expect(entry.archived).toBe(false);
      expect(entry.tags).toEqual(["deploy", "infra"]);
    });

    it("creates a convention with 90-day default decay", () => {
      const entry = store.createEntry({
        type: "convention",
        content: "Always snapshot before deploying",
      });
      expect(entry.decayDays).toBe(90);
    });

    it("allows custom decayDays", () => {
      const entry = store.createEntry({
        type: "lesson",
        content: "Some lesson",
        decayDays: 60,
      });
      expect(entry.decayDays).toBe(60);
    });

    it("rejects empty content", () => {
      expect(() =>
        store.createEntry({ type: "warning", content: "" }),
      ).toThrow(ValidationError);
    });

    it("rejects invalid type", () => {
      expect(() =>
        store.createEntry({ type: "invalid" as EntryType, content: "test" }),
      ).toThrow(ValidationError);
    });

    it("rejects confidence out of range", () => {
      expect(() =>
        store.createEntry({ type: "fact", content: "test", confidence: 11 }),
      ).toThrow(ValidationError);
    });
  });

  describe("updateEntry", () => {
    it("updates content and tags", () => {
      const entry = store.createEntry({ type: "warning", content: "old" });
      const updated = store.updateEntry(entry.id, {
        content: "new",
        tags: ["updated"],
      });
      expect(updated.content).toBe("new");
      expect(updated.tags).toEqual(["updated"]);
    });

    it("reinforces: resets decay timer and bumps confidence", () => {
      const entry = store.createEntry({
        type: "lesson",
        content: "some lesson",
        confidence: 5,
      });
      const originalReinforced = entry.lastReinforced;

      // Small delay to ensure timestamp differs
      const updated = store.updateEntry(entry.id, { reinforce: true });
      expect(updated.confidence).toBe(6);
      expect(updated.lastReinforced >= originalReinforced).toBe(true);
    });

    it("confidence caps at 10 on reinforcement", () => {
      const entry = store.createEntry({
        type: "warning",
        content: "test",
        confidence: 10,
      });
      const updated = store.updateEntry(entry.id, { reinforce: true });
      expect(updated.confidence).toBe(10);
    });

    it("can archive an entry", () => {
      const entry = store.createEntry({ type: "fact", content: "test" });
      const updated = store.updateEntry(entry.id, { archived: true });
      expect(updated.archived).toBe(true);
    });

    it("throws NotFoundError for missing entry", () => {
      expect(() =>
        store.updateEntry("nonexistent", { content: "x" }),
      ).toThrow(NotFoundError);
    });
  });

  describe("listEntries", () => {
    beforeEach(() => {
      store.createEntry({ type: "warning", content: "warn1", tags: ["deploy"] });
      store.createEntry({ type: "warning", content: "warn2", tags: ["infra"] });
      store.createEntry({ type: "convention", content: "conv1", tags: ["deploy"] });
      store.createEntry({ type: "lesson", content: "lesson1", tags: ["infra"] });
      store.createEntry({ type: "context", content: "ctx1", tags: ["focus"] });
    });

    it("lists all entries", () => {
      const entries = store.listEntries();
      expect(entries.length).toBe(5);
    });

    it("filters by type", () => {
      const entries = store.listEntries({ type: "warning" });
      expect(entries.length).toBe(2);
    });

    it("filters by tag", () => {
      const entries = store.listEntries({ tag: "deploy" });
      expect(entries.length).toBe(2);
    });

    it("filters active entries", () => {
      const entries = store.listEntries({ active: true });
      expect(entries.length).toBe(5); // all are fresh
    });

    it("searches content", () => {
      const entries = store.listEntries({ search: "warn1" });
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe("warn1");
    });

    it("searches tags", () => {
      const entries = store.listEntries({ search: "focus" });
      expect(entries.length).toBe(1);
    });
  });

  describe("isExpired", () => {
    it("returns false for fresh entry", () => {
      const entry = store.createEntry({ type: "warning", content: "fresh" });
      expect(store.isExpired(entry)).toBe(false);
    });

    it("returns true for entry past decay window", () => {
      const entry = store.createEntry({
        type: "warning",
        content: "old",
        decayDays: 0, // expires immediately
      });
      // Force lastReinforced to the past
      store.updateEntry(entry.id, {}); // no-op to get reference
      const raw = store.getEntry(entry.id)!;
      // Manually set to past (hacky but effective for testing)
      (raw as any).lastReinforced = new Date(
        Date.now() - 1000,
      ).toISOString();
      expect(store.isExpired(raw)).toBe(true);
    });
  });

  describe("sessionBriefing", () => {
    it("returns structured briefing with sections", () => {
      store.createEntry({ type: "warning", content: "Do not use pkill" });
      store.createEntry({ type: "context", content: "Noah is focused on seed spec" });
      store.createEntry({ type: "convention", content: "Snapshot before deploy" });
      store.createEntry({ type: "lesson", content: "Built but not running pattern" });

      const briefing = store.sessionBriefing();
      expect(briefing).toContain("# Session Briefing");
      expect(briefing).toContain("⚠️ Active Warnings");
      expect(briefing).toContain("Do not use pkill");
      expect(briefing).toContain("📋 Current Context");
      expect(briefing).toContain("📐 Conventions");
      expect(briefing).toContain("💡 Recent Lessons");
    });

    it("returns empty message when no entries", () => {
      const briefing = store.sessionBriefing();
      expect(briefing).toContain("No active knowledge entries");
    });

    it("respects token budget", () => {
      // Add many entries
      for (let i = 0; i < 100; i++) {
        store.createEntry({ type: "warning", content: `Warning number ${i} with some extra content to take up space in the briefing` });
      }
      const briefing = store.sessionBriefing(500);
      const tokens = store.estimateTokens(briefing);
      // Should be roughly within budget (may slightly exceed due to headers)
      expect(tokens).toBeLessThan(600);
    });
  });

  describe("taskBriefing", () => {
    it("filters by tags and includes warnings", () => {
      store.createEntry({ type: "warning", content: "Global warning", tags: [] });
      store.createEntry({ type: "convention", content: "Deploy convention", tags: ["deploy"] });
      store.createEntry({ type: "lesson", content: "Infra lesson", tags: ["infra"] });
      store.createEntry({ type: "context", content: "Unrelated context", tags: ["frontend"] });

      const briefing = store.taskBriefing(["deploy", "infra"]);
      expect(briefing).toContain("Global warning"); // warnings always included
      expect(briefing).toContain("Deploy convention");
      expect(briefing).toContain("Infra lesson");
      expect(briefing).not.toContain("Unrelated context");
    });
  });

  describe("extractFromText", () => {
    it("extracts entries from prefixed lines", () => {
      const text = `
WARNING: Do not use nohup for agent-services
CONVENTION: Always use atomic writes
LESSON: Fleet agents need explicit startup commands
CONTEXT: Noah is focused on seed spec
FACT: Infra VM is e0e2bf05
Some random line that should be ignored
      `;

      const extracted = store.extractFromText(text, "test-source");
      expect(extracted.length).toBe(5);
      expect(extracted[0].type).toBe("warning");
      expect(extracted[1].type).toBe("convention");
      expect(extracted[2].type).toBe("lesson");
      expect(extracted[3].type).toBe("context");
      expect(extracted[4].type).toBe("fact");
      expect(extracted[0].source).toBe("test-source");
      expect(extracted[0].tags).toEqual(["extracted"]);
    });

    it("handles empty text", () => {
      const extracted = store.extractFromText("");
      expect(extracted.length).toBe(0);
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      store.createEntry({ type: "warning", content: "w1" });
      store.createEntry({ type: "convention", content: "c1" });
      store.createEntry({ type: "lesson", content: "l1" });

      const s = store.stats();
      expect(s.total).toBe(3);
      expect(s.active).toBe(3);
      expect(s.expired).toBe(0);
      expect(s.archived).toBe(0);
      expect(s.byType.warning).toBe(1);
      expect(s.byType.convention).toBe(1);
      expect(s.byType.lesson).toBe(1);
    });
  });

  describe("persistence", () => {
    it("survives reload", () => {
      const path = `/tmp/kb-persist-test-${Date.now()}.json`;
      const store1 = new KBStore(path);
      store1.createEntry({ type: "warning", content: "persist me" });
      store1.flush();

      const store2 = new KBStore(path);
      const entries = store2.listEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe("persist me");
    });
  });
});
