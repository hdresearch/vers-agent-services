import { describe, it, expect } from "vitest";
import { analyzeBoard, summarizeAnalysis } from "../analyzer.js";
import type { Task } from "../../board/store.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id || `task-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title || "Test task",
    status: overrides.status || "open",
    tags: overrides.tags || [],
    dependencies: overrides.dependencies || [],
    createdBy: "test",
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    notes: [],
    artifacts: [],
    score: overrides.score ?? 0,
    effort: overrides.effort,
    ...overrides,
  };
}

describe("analyzeBoard", () => {
  it("counts tasks by status", () => {
    const tasks = [
      makeTask({ status: "open" }),
      makeTask({ status: "open" }),
      makeTask({ status: "blocked" }),
      makeTask({ status: "done" }),
      makeTask({ status: "in_progress" }),
    ];

    const analysis = analyzeBoard(tasks);
    expect(analysis.counts.total).toBe(5);
    expect(analysis.counts.byStatus.open).toBe(2);
    expect(analysis.counts.byStatus.blocked).toBe(1);
    expect(analysis.counts.byStatus.done).toBe(1);
    expect(analysis.counts.byStatus.in_progress).toBe(1);
  });

  it("counts tasks by effort", () => {
    const tasks = [
      makeTask({ effort: "small" }),
      makeTask({ effort: "small" }),
      makeTask({ effort: "large" }),
      makeTask({}), // no effort set
    ];

    const analysis = analyzeBoard(tasks);
    expect(analysis.counts.byEffort.small).toBe(2);
    expect(analysis.counts.byEffort.large).toBe(1);
    expect(analysis.counts.byEffort.unset).toBe(1);
  });

  it("classifies P0 tasks correctly", () => {
    const tasks = [
      makeTask({ id: "blocked-1", status: "blocked" }),
      makeTask({ id: "high-score", status: "open", score: 5 }),
      makeTask({ id: "critical-tag", status: "open", tags: ["P0"] }),
      makeTask({ id: "normal", status: "open", score: 0 }),
    ];

    const analysis = analyzeBoard(tasks);
    const p0Ids = analysis.priority.p0_critical.map((t) => t.id);
    expect(p0Ids).toContain("blocked-1");
    expect(p0Ids).toContain("high-score");
    expect(p0Ids).toContain("critical-tag");
    expect(p0Ids).not.toContain("normal");
  });

  it("classifies P1 and P2 tasks", () => {
    const tasks = [
      makeTask({ id: "has-deps", status: "open", dependencies: ["other"] }),
      makeTask({ id: "has-score", status: "open", score: 1 }),
      makeTask({ id: "plain", status: "open", score: 0 }),
    ];

    const analysis = analyzeBoard(tasks);
    const p1Ids = analysis.priority.p1_important.map((t) => t.id);
    const p2Ids = analysis.priority.p2_backlog.map((t) => t.id);

    expect(p1Ids).toContain("has-deps");
    expect(p1Ids).toContain("has-score");
    expect(p2Ids).toContain("plain");
  });

  it("detects stale tasks (7+ days)", () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    const tasks = [
      makeTask({ id: "stale-1", status: "open", updatedAt: old }),
      makeTask({ id: "fresh", status: "open", updatedAt: recent }),
    ];

    const analysis = analyzeBoard(tasks);
    expect(analysis.health.staleTaskIds).toContain("stale-1");
    expect(analysis.health.staleTaskIds).not.toContain("fresh");
  });

  it("identifies theme clusters from tags", () => {
    const tasks = [
      makeTask({ tags: ["infra", "deploy"] }),
      makeTask({ tags: ["infra", "monitoring"] }),
      makeTask({ tags: ["infra"] }),
      makeTask({ tags: ["blog"] }),
    ];

    const analysis = analyzeBoard(tasks);
    const infraTheme = analysis.themes.find((t) => t.tag === "infra");
    expect(infraTheme).toBeDefined();
    expect(infraTheme!.count).toBe(3);
  });

  it("finds parallelizable tasks (no deps)", () => {
    const tasks = [
      makeTask({ id: "no-deps", status: "open", dependencies: [] }),
      makeTask({ id: "has-deps", status: "open", dependencies: ["other"] }),
      makeTask({ id: "done-no-deps", status: "done", dependencies: [] }),
    ];

    const analysis = analyzeBoard(tasks);
    expect(analysis.parallelizable).toContain("no-deps");
    expect(analysis.parallelizable).not.toContain("has-deps");
    expect(analysis.parallelizable).not.toContain("done-no-deps");
  });

  it("finds dependency chains", () => {
    const tasks = [
      makeTask({ id: "root", status: "open", dependencies: [] }),
      makeTask({ id: "child", status: "open", dependencies: ["root"] }),
      makeTask({ id: "grandchild", status: "open", dependencies: ["child"] }),
    ];

    const analysis = analyzeBoard(tasks);
    expect(analysis.sequential.length).toBeGreaterThan(0);
    const chain = analysis.sequential.find((c) => c.root === "root");
    expect(chain).toBeDefined();
    expect(chain!.chain).toEqual(["root", "child", "grandchild"]);
  });

  it("handles empty board", () => {
    const analysis = analyzeBoard([]);
    expect(analysis.counts.total).toBe(0);
    expect(analysis.priority.p0_critical).toEqual([]);
    expect(analysis.themes).toEqual([]);
    expect(analysis.health.staleDays).toBe(0);
  });
});

describe("summarizeAnalysis", () => {
  it("produces a readable summary", () => {
    const analysis = analyzeBoard([
      makeTask({ status: "open", tags: ["infra"] }),
      makeTask({ status: "blocked", tags: ["infra"] }),
    ]);

    const summary = summarizeAnalysis(analysis);
    expect(summary).toContain("2 tasks");
    expect(summary).toContain("1 open");
    expect(summary).toContain("1 blocked");
    expect(summary).toContain("infra");
  });
});
