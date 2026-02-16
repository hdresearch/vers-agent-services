import { describe, it, expect } from "vitest";
import { KBStore } from "../kb/store.js";
import { seedKB } from "../kb/seed.js";

describe("KB Seed", () => {
  it("seeds ~22 entries covering all types", () => {
    const store = new KBStore(
      `/tmp/kb-seed-test-${Date.now()}.json`,
    );
    const result = seedKB(store);

    expect(result.created).toBeGreaterThanOrEqual(20);

    const stats = store.stats();
    expect(stats.byType.warning).toBeGreaterThanOrEqual(5);
    expect(stats.byType.convention).toBeGreaterThanOrEqual(5);
    expect(stats.byType.lesson).toBeGreaterThanOrEqual(3);
    expect(stats.byType.context).toBeGreaterThanOrEqual(3);
    expect(stats.byType.fact).toBeGreaterThanOrEqual(3);
    expect(stats.active).toBe(stats.total);
    expect(stats.archived).toBe(0);
  });

  it("session briefing after seeding covers all sections", () => {
    const store = new KBStore(
      `/tmp/kb-briefing-test-${Date.now()}.json`,
    );
    seedKB(store);

    const briefing = store.sessionBriefing();
    expect(briefing).toContain("⚠️ Active Warnings");
    expect(briefing).toContain("📋 Current Context");
    expect(briefing).toContain("📐 Conventions");
    expect(briefing).toContain("💡 Recent Lessons");
    expect(briefing).toContain("systemd");
    expect(briefing).toContain("snapshot");

    // Check token budget is reasonable
    const tokens = store.estimateTokens(briefing);
    expect(tokens).toBeLessThan(5000);
    expect(tokens).toBeGreaterThan(500);
  });

  it("task briefing filters by tags", () => {
    const store = new KBStore(
      `/tmp/kb-task-briefing-test-${Date.now()}.json`,
    );
    seedKB(store);

    const briefing = store.taskBriefing(["deploy", "infra"]);
    expect(briefing).toContain("deploy");
    expect(briefing).toContain("snapshot");
    // Should NOT include unrelated entries
    expect(briefing).not.toContain("seed spec RFC");
  });
});
