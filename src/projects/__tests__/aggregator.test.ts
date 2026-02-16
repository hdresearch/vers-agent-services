import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProjectAggregator, type UnifiedProjectView } from "../aggregator.js";
import type { Project } from "../store.js";

// Mock fetch for testing the aggregator without a live server
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const testProject: Project = {
  id: "01TEST",
  name: "test-project",
  displayName: "Test Project",
  description: "A test project",
  status: "active",
  tags: ["test", "demo"],
  matchers: {
    boardTags: ["test"],
    boardTitlePatterns: ["test.*task"],
    reportTags: ["test"],
    reportAuthors: ["test-agent"],
    feedPatterns: ["test"],
    logPatterns: ["test"],
    gitBranches: [],
    agents: ["test-agent"],
    repos: ["hdresearch/test"],
  },
  createdAt: "2026-02-16T00:00:00Z",
  updatedAt: "2026-02-16T00:00:00Z",
};

describe("ProjectAggregator", () => {
  let aggregator: ProjectAggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    aggregator = new ProjectAggregator({
      baseUrl: "http://localhost:3000",
      authToken: "test-token",
    });
  });

  it("builds a view with empty services", async () => {
    // All services return empty responses
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [], reports: [], vms: [], entries: [] }),
    });

    const view = await aggregator.buildView(testProject);

    expect(view.project).toEqual(testProject);
    expect(view.board.total).toBe(0);
    expect(view.reports).toEqual([]);
    expect(view.feed.totalEvents).toBe(0);
    expect(view.health.completionRate).toBe(0);
  });

  it("matches board tasks by tag", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/board/tasks")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [
              {
                id: "t1",
                title: "Test task 1",
                status: "done",
                tags: ["test"],
                assignee: "test-agent",
                updatedAt: "2026-02-15T00:00:00Z",
              },
              {
                id: "t2",
                title: "Unrelated task",
                status: "open",
                tags: ["other"],
                updatedAt: "2026-02-14T00:00:00Z",
              },
              {
                id: "t3",
                title: "Test pattern task",
                status: "open",
                tags: [],
                updatedAt: "2026-02-16T00:00:00Z",
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ tasks: [], reports: [], vms: [], entries: [] }),
      };
    });

    // Need to handle the feed events endpoint returning an array
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/board/tasks")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [
              {
                id: "t1",
                title: "Test task 1",
                status: "done",
                tags: ["test"],
                assignee: "test-agent",
                updatedAt: "2026-02-15T00:00:00Z",
              },
              {
                id: "t2",
                title: "Unrelated",
                status: "open",
                tags: ["other"],
                updatedAt: "2026-02-14T00:00:00Z",
              },
              {
                id: "t3",
                title: "Test pattern task",
                status: "open",
                tags: [],
                updatedAt: "2026-02-16T00:00:00Z",
              },
            ],
          }),
        };
      }
      if (url.includes("/feed/events")) {
        return { ok: true, json: async () => [] };
      }
      if (url.includes("/log")) {
        return { ok: true, json: async () => ({ entries: [] }) };
      }
      if (url.includes("/registry/vms")) {
        return { ok: true, json: async () => ({ vms: [] }) };
      }
      // reports
      return { ok: true, json: async () => ({ reports: [] }) };
    });

    const view = await aggregator.buildView(testProject);

    // t1 matches by tag "test", t3 matches by title pattern "test.*task"
    expect(view.board.total).toBe(2);
    expect(view.board.done).toBe(1);
    expect(view.board.open).toBe(1);
    expect(view.health.completionRate).toBe(0.5);
  });

  it("matches feed events by agent and pattern", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/feed/events")) {
        return {
          ok: true,
          json: async () => [
            {
              id: "e1",
              agent: "test-agent",
              type: "task_completed",
              summary: "Done with X",
              timestamp: "2026-02-16T01:00:00Z",
            },
            {
              id: "e2",
              agent: "other-agent",
              type: "finding",
              summary: "Found a test issue",
              timestamp: "2026-02-16T02:00:00Z",
            },
            {
              id: "e3",
              agent: "other-agent",
              type: "custom",
              summary: "Unrelated event",
              timestamp: "2026-02-16T03:00:00Z",
            },
          ],
        };
      }
      if (url.includes("/board/tasks")) {
        return { ok: true, json: async () => ({ tasks: [] }) };
      }
      if (url.includes("/log")) {
        return { ok: true, json: async () => ({ entries: [] }) };
      }
      if (url.includes("/registry/vms")) {
        return { ok: true, json: async () => ({ vms: [] }) };
      }
      return { ok: true, json: async () => ({ reports: [] }) };
    });

    const view = await aggregator.buildView(testProject);

    // e1 matches by agent "test-agent", e2 matches by pattern "test" in summary
    expect(view.feed.totalEvents).toBe(2);
    expect(view.feed.recentEvents).toHaveLength(2);
  });

  it("handles service failures gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const view = await aggregator.buildView(testProject);

    // Should return empty data, not throw
    expect(view.project).toEqual(testProject);
    expect(view.board.total).toBe(0);
    expect(view.reports).toEqual([]);
    expect(view.feed.totalEvents).toBe(0);
  });

  it("computes health correctly", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/board/tasks")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [
              { id: "t1", title: "A", status: "done", tags: ["test"], updatedAt: "2026-02-14T00:00:00Z" },
              { id: "t2", title: "B", status: "done", tags: ["test"], updatedAt: "2026-02-15T00:00:00Z" },
              { id: "t3", title: "Blocked C", status: "blocked", tags: ["test"], updatedAt: "2026-02-16T00:00:00Z" },
              { id: "t4", title: "D", status: "open", tags: ["test"], updatedAt: "2026-02-16T00:00:00Z" },
            ],
          }),
        };
      }
      if (url.includes("/feed/events")) return { ok: true, json: async () => [] };
      if (url.includes("/log")) return { ok: true, json: async () => ({ entries: [] }) };
      if (url.includes("/registry/vms")) {
        return {
          ok: true,
          json: async () => ({
            vms: [{ name: "test-agent-vm", role: "test-agent", status: "registered" }],
          }),
        };
      }
      return { ok: true, json: async () => ({ reports: [] }) };
    });

    const view = await aggregator.buildView(testProject);

    expect(view.health.completionRate).toBe(0.5); // 2/4
    expect(view.health.activeAgents).toBe(1);
    expect(view.health.blockers).toEqual(["Blocked C"]);
    expect(view.health.lastActivity).toBeTruthy();
  });
});
