/**
 * Project Aggregator — collects data from all fleet services and builds
 * the unified project view. This is the heart of the projects module.
 *
 * Design: The aggregator takes an HTTP base URL and auth token, then calls
 * the fleet's own API endpoints to gather data. This means:
 *  - It works across services (even in microservice mode)
 *  - It uses the same API any external consumer would use
 *  - It's easy to test with mocked responses
 *
 * For in-process use (monolith), we also accept store references directly
 * to skip the HTTP round-trip.
 */

import type { Project, ProjectMatchers } from "./store.js";

// ── Aggregated view types ──────────────────────────────────────────────

export interface BoardSummary {
  total: number;
  open: number;
  inProgress: number;
  blocked: number;
  done: number;
  tasks: BoardTaskRef[];
}

export interface BoardTaskRef {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  updatedAt: string;
}

export interface ReportRef {
  id: string;
  title: string;
  author: string;
  tags: string[];
  createdAt: string;
}

export interface AgentSummary {
  name: string;
  status: string;
  lastSeen?: string;
}

export interface FeedSummary {
  recentEvents: FeedEventRef[];
  totalEvents: number;
}

export interface FeedEventRef {
  id: string;
  agent: string;
  type: string;
  summary: string;
  timestamp: string;
}

export interface LogSummary {
  recentEntries: LogEntryRef[];
  totalEntries: number;
}

export interface LogEntryRef {
  id: string;
  text: string;
  agent?: string;
  timestamp: string;
}

export interface TimelineEntry {
  date: string;
  event: string;
  agent?: string;
  source: string; // "board" | "feed" | "report" | "log"
  sourceId?: string;
}

export interface ProjectHealth {
  completionRate: number;
  activeAgents: number;
  lastActivity: string | null;
  blockers: string[];
}

export interface UnifiedProjectView {
  project: Project;
  board: BoardSummary;
  reports: ReportRef[];
  agents: AgentSummary[];
  feed: FeedSummary;
  log: LogSummary;
  timeline: TimelineEntry[];
  health: ProjectHealth;
}

// ── Aggregator ─────────────────────────────────────────────────────────

export interface AggregatorDeps {
  baseUrl: string;
  authToken: string;
}

export class ProjectAggregator {
  constructor(private deps: AggregatorDeps) {}

  async buildView(project: Project): Promise<UnifiedProjectView> {
    const m = project.matchers;

    // Fire all queries in parallel
    const [boardData, reportData, feedData, logData, registryData] =
      await Promise.all([
        this.gatherBoard(m),
        this.gatherReports(m),
        this.gatherFeed(m, project.tags),
        this.gatherLog(m),
        this.gatherRegistry(m),
      ]);

    // Build timeline from all sources
    const timeline = this.buildTimeline(
      boardData,
      reportData,
      feedData,
      logData,
    );

    // Compute health metrics
    const health = this.computeHealth(boardData, feedData, registryData);

    return {
      project,
      board: boardData,
      reports: reportData,
      agents: registryData,
      feed: feedData,
      log: logData,
      timeline,
      health,
    };
  }

  // ── Board ────────────────────────────────────────────────────────────

  private async gatherBoard(m: ProjectMatchers): Promise<BoardSummary> {
    const empty: BoardSummary = {
      total: 0,
      open: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
      tasks: [],
    };

    try {
      // Fetch all tasks (we'll filter client-side by matchers)
      const resp = await this.fetch("/board/tasks");
      if (!resp.ok) return empty;

      const data = await resp.json();
      const allTasks: any[] = data.tasks || [];

      // Filter by board tags + title patterns
      const matched = allTasks.filter((t: any) => {
        // Tag match
        if (
          m.boardTags.length > 0 &&
          t.tags?.some((tag: string) =>
            m.boardTags.some(
              (bt) => tag.toLowerCase() === bt.toLowerCase(),
            ),
          )
        ) {
          return true;
        }
        // Title pattern match
        if (m.boardTitlePatterns.length > 0) {
          for (const pattern of m.boardTitlePatterns) {
            try {
              if (new RegExp(pattern, "i").test(t.title)) return true;
            } catch {
              // invalid regex, skip
            }
          }
        }
        return false;
      });

      const tasks: BoardTaskRef[] = matched.map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee,
        updatedAt: t.updatedAt,
      }));

      return {
        total: matched.length,
        open: matched.filter((t: any) => t.status === "open").length,
        inProgress: matched.filter((t: any) => t.status === "in_progress")
          .length,
        blocked: matched.filter((t: any) => t.status === "blocked").length,
        done: matched.filter((t: any) => t.status === "done").length,
        tasks,
      };
    } catch {
      return empty;
    }
  }

  // ── Reports ──────────────────────────────────────────────────────────

  private async gatherReports(m: ProjectMatchers): Promise<ReportRef[]> {
    try {
      const reports: ReportRef[] = [];

      // By tag
      for (const tag of m.reportTags) {
        const resp = await this.fetch(`/reports?tag=${encodeURIComponent(tag)}`);
        if (resp.ok) {
          const data = await resp.json();
          for (const r of data.reports || []) {
            if (!reports.find((x) => x.id === r.id)) {
              reports.push({
                id: r.id,
                title: r.title,
                author: r.author,
                tags: r.tags || [],
                createdAt: r.createdAt,
              });
            }
          }
        }
      }

      // By author
      for (const author of m.reportAuthors) {
        const resp = await this.fetch(
          `/reports?author=${encodeURIComponent(author)}`,
        );
        if (resp.ok) {
          const data = await resp.json();
          for (const r of data.reports || []) {
            if (!reports.find((x) => x.id === r.id)) {
              reports.push({
                id: r.id,
                title: r.title,
                author: r.author,
                tags: r.tags || [],
                createdAt: r.createdAt,
              });
            }
          }
        }
      }

      return reports.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  // ── Feed ─────────────────────────────────────────────────────────────

  private async gatherFeed(
    m: ProjectMatchers,
    projectTags: string[],
  ): Promise<FeedSummary> {
    const empty: FeedSummary = { recentEvents: [], totalEvents: 0 };
    try {
      // Get recent events and filter by agents + patterns
      const resp = await this.fetch("/feed/events?limit=200");
      if (!resp.ok) return empty;

      const events: any[] = await resp.json();
      const allPatterns = [
        ...m.feedPatterns,
        ...projectTags.map((t) => t.toLowerCase()),
      ];

      const matched = events.filter((e: any) => {
        // Agent match
        if (
          m.agents.length > 0 &&
          m.agents.some(
            (a) => e.agent?.toLowerCase().includes(a.toLowerCase()),
          )
        ) {
          return true;
        }
        // Pattern match on summary
        if (allPatterns.length > 0) {
          const text = (e.summary || "").toLowerCase();
          if (allPatterns.some((p) => text.includes(p.toLowerCase()))) {
            return true;
          }
        }
        return false;
      });

      const recent = matched.slice(-20).map((e: any) => ({
        id: e.id,
        agent: e.agent,
        type: e.type,
        summary: e.summary,
        timestamp: e.timestamp,
      }));

      return {
        recentEvents: recent,
        totalEvents: matched.length,
      };
    } catch {
      return empty;
    }
  }

  // ── Log ──────────────────────────────────────────────────────────────

  private async gatherLog(m: ProjectMatchers): Promise<LogSummary> {
    const empty: LogSummary = { recentEntries: [], totalEntries: 0 };
    try {
      const resp = await this.fetch("/log?last=7d");
      if (!resp.ok) return empty;

      const data = await resp.json();
      const entries: any[] = data.entries || [];

      const allPatterns = [...m.logPatterns];

      const matched = entries.filter((e: any) => {
        // Agent match
        if (
          m.agents.length > 0 &&
          m.agents.some(
            (a) => e.agent?.toLowerCase().includes(a.toLowerCase()),
          )
        ) {
          return true;
        }
        // Text pattern match
        if (allPatterns.length > 0) {
          const text = (e.text || "").toLowerCase();
          if (allPatterns.some((p) => text.includes(p.toLowerCase()))) {
            return true;
          }
        }
        return false;
      });

      const recent = matched.slice(-10).map((e: any) => ({
        id: e.id,
        text: e.text,
        agent: e.agent,
        timestamp: e.timestamp,
      }));

      return {
        recentEntries: recent,
        totalEntries: matched.length,
      };
    } catch {
      return empty;
    }
  }

  // ── Registry ─────────────────────────────────────────────────────────

  private async gatherRegistry(
    m: ProjectMatchers,
  ): Promise<AgentSummary[]> {
    try {
      if (m.agents.length === 0) return [];

      const resp = await this.fetch("/registry/vms");
      if (!resp.ok) return [];

      const data = await resp.json();
      const vms: any[] = data.vms || [];

      // Match by agent name patterns
      const matched: AgentSummary[] = [];
      for (const agent of m.agents) {
        const vm = vms.find((v: any) =>
          v.name?.toLowerCase().includes(agent.toLowerCase()) ||
          v.role?.toLowerCase().includes(agent.toLowerCase()),
        );
        matched.push({
          name: agent,
          status: vm ? vm.status || "registered" : "unknown",
          lastSeen: vm?.lastHeartbeat || vm?.registeredAt,
        });
      }

      return matched;
    } catch {
      return [];
    }
  }

  // ── Timeline ─────────────────────────────────────────────────────────

  private buildTimeline(
    board: BoardSummary,
    reports: ReportRef[],
    feed: FeedSummary,
    log: LogSummary,
  ): TimelineEntry[] {
    const entries: TimelineEntry[] = [];

    // Board task completions
    for (const t of board.tasks.filter((t) => t.status === "done")) {
      entries.push({
        date: t.updatedAt,
        event: `Task completed: ${t.title}`,
        agent: t.assignee,
        source: "board",
        sourceId: t.id,
      });
    }

    // Reports published
    for (const r of reports) {
      entries.push({
        date: r.createdAt,
        event: `Report: ${r.title}`,
        agent: r.author,
        source: "report",
        sourceId: r.id,
      });
    }

    // Key feed events (task_completed, finding)
    for (const e of feed.recentEvents.filter(
      (e) =>
        e.type === "task_completed" ||
        e.type === "finding" ||
        e.type === "task_started",
    )) {
      entries.push({
        date: e.timestamp,
        event: e.summary,
        agent: e.agent,
        source: "feed",
        sourceId: e.id,
      });
    }

    // Sort by date descending, take top 30
    entries.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    return entries.slice(0, 30);
  }

  // ── Health ───────────────────────────────────────────────────────────

  private computeHealth(
    board: BoardSummary,
    feed: FeedSummary,
    agents: AgentSummary[],
  ): ProjectHealth {
    const completionRate =
      board.total > 0 ? board.done / board.total : 0;

    const activeAgents = agents.filter(
      (a) =>
        a.status === "registered" ||
        a.status === "healthy" ||
        a.status === "active",
    ).length;

    const timestamps = [
      ...feed.recentEvents.map((e) => e.timestamp),
      ...board.tasks.map((t) => t.updatedAt),
    ];
    const lastActivity =
      timestamps.length > 0
        ? timestamps.sort().reverse()[0]
        : null;

    const blockers = board.tasks
      .filter((t) => t.status === "blocked")
      .map((t) => t.title);

    return {
      completionRate: Math.round(completionRate * 100) / 100,
      activeAgents,
      lastActivity,
      blockers,
    };
  }

  // ── HTTP helper ──────────────────────────────────────────────────────

  private async fetch(path: string): Promise<Response> {
    return globalThis.fetch(`${this.deps.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.deps.authToken}`,
        "Content-Type": "application/json",
      },
    });
  }
}
