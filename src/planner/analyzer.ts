import type { Task, TaskStatus } from "../board/store.js";

// --- Types ---

export interface BoardAnalysis {
  counts: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    byEffort: Record<string, number>;
  };
  priority: {
    p0_critical: Task[];    // blocked or high-score open tasks
    p1_important: Task[];   // open tasks with dependencies or score > 0
    p2_backlog: Task[];     // everything else open
  };
  health: {
    blockedCount: number;
    staleDays: number;       // avg days since last update on open tasks
    staleTaskIds: string[];  // open tasks not updated in 7+ days
    inProgressCount: number;
    inReviewCount: number;
  };
  themes: ThemeCluster[];
  parallelizable: string[];   // task IDs that have no deps and can run in parallel
  sequential: DependencyChain[];
}

export interface ThemeCluster {
  tag: string;
  count: number;
  taskIds: string[];
}

export interface DependencyChain {
  root: string;
  chain: string[];
}

// --- Analyzer ---

export function analyzeBoard(tasks: Task[]): BoardAnalysis {
  const byStatus: Record<string, number> = { open: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 };
  const byEffort: Record<string, number> = { trivial: 0, small: 0, medium: 0, large: 0, unset: 0 };
  const tagMap = new Map<string, string[]>();

  const now = Date.now();
  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  const p0: Task[] = [];
  const p1: Task[] = [];
  const p2: Task[] = [];
  const staleIds: string[] = [];
  let totalStaleDays = 0;
  let openCount = 0;

  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byEffort[t.effort || "unset"] = (byEffort[t.effort || "unset"] || 0) + 1;

    for (const tag of t.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(t.id);
    }

    if (t.status === "open" || t.status === "in_progress") {
      openCount++;
      const daysSinceUpdate = (now - new Date(t.updatedAt).getTime()) / (24 * 60 * 60 * 1000);
      totalStaleDays += daysSinceUpdate;

      if (daysSinceUpdate > 7) {
        staleIds.push(t.id);
      }
    }

    // Priority classification
    if (t.status === "blocked") {
      p0.push(t);
    } else if (t.status === "open") {
      if (t.score >= 3 || (t.tags.some((tag) => tag === "P0" || tag === "critical" || tag === "urgent"))) {
        p0.push(t);
      } else if (t.score > 0 || t.dependencies.length > 0) {
        p1.push(t);
      } else {
        p2.push(t);
      }
    }
  }

  // Theme clusters
  const themes: ThemeCluster[] = [];
  for (const [tag, taskIds] of tagMap) {
    if (taskIds.length >= 2) {
      themes.push({ tag, count: taskIds.length, taskIds });
    }
  }
  themes.sort((a, b) => b.count - a.count);

  // Parallelizable: open tasks with no dependencies
  const allTaskIds = new Set(tasks.map((t) => t.id));
  const dependedOn = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.dependencies) dependedOn.add(dep);
  }

  const parallelizable = tasks
    .filter((t) => t.status === "open" && t.dependencies.length === 0)
    .map((t) => t.id);

  // Dependency chains
  const sequential = findDependencyChains(tasks);

  return {
    counts: {
      total: tasks.length,
      byStatus: byStatus as Record<TaskStatus, number>,
      byEffort,
    },
    priority: {
      p0_critical: p0,
      p1_important: p1,
      p2_backlog: p2,
    },
    health: {
      blockedCount: byStatus.blocked || 0,
      staleDays: openCount > 0 ? Math.round(totalStaleDays / openCount) : 0,
      staleTaskIds: staleIds,
      inProgressCount: byStatus.in_progress || 0,
      inReviewCount: byStatus.in_review || 0,
    },
    themes,
    parallelizable,
    sequential,
  };
}

function findDependencyChains(tasks: Task[]): DependencyChain[] {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const chains: DependencyChain[] = [];
  const visited = new Set<string>();

  // Find tasks that are depended on but don't depend on anything (roots)
  const hasIncoming = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      hasIncoming.add(dep);
    }
  }

  // Build reverse map: dep -> tasks that depend on it
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(t.id);
    }
  }

  // Walk from each root
  for (const t of tasks) {
    if (t.dependencies.length > 0) continue; // Not a root
    if (!dependents.has(t.id)) continue;       // No one depends on this
    if (visited.has(t.id)) continue;

    const chain: string[] = [t.id];
    visited.add(t.id);
    let current = t.id;

    while (dependents.has(current)) {
      const nexts = dependents.get(current)!;
      // Follow the first unvisited dependent
      const next = nexts.find((id) => !visited.has(id));
      if (!next) break;
      chain.push(next);
      visited.add(next);
      current = next;
    }

    if (chain.length > 1) {
      chains.push({ root: t.id, chain });
    }
  }

  return chains;
}

/**
 * Summarize analysis into a compact string for LLM context.
 */
export function summarizeAnalysis(analysis: BoardAnalysis): string {
  const lines: string[] = [];
  const { counts, priority, health, themes } = analysis;

  lines.push(`Board: ${counts.total} tasks (${counts.byStatus.open} open, ${counts.byStatus.in_progress} active, ${counts.byStatus.blocked} blocked, ${counts.byStatus.done} done)`);
  lines.push(`Priority: ${priority.p0_critical.length} P0, ${priority.p1_important.length} P1, ${priority.p2_backlog.length} P2`);
  lines.push(`Health: ${health.blockedCount} blocked, ${health.staleTaskIds.length} stale (7d+), avg age ${health.staleDays}d`);

  if (themes.length > 0) {
    lines.push(`Themes: ${themes.slice(0, 8).map((t) => `${t.tag}(${t.count})`).join(", ")}`);
  }

  lines.push(`Parallelizable: ${analysis.parallelizable.length} tasks, Sequential chains: ${analysis.sequential.length}`);

  return lines.join("\n");
}
