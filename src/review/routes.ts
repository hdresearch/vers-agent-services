import { Hono } from "hono";
import {
  NotFoundError,
  ValidationError,
  type AddArtifactInput,
} from "../board/store.js";
import { boardStore as store } from "../board/shared-store.js";
import { reportsStore } from "../reports/shared-store.js";
import { notificationStore } from "../notifications/routes.js";

export const reviewRoutes = new Hono();

// ─── Structured Review Submission ───
// POST /review/submit — the ONLY way to enter review state
reviewRoutes.post("/submit", async (c) => {
  try {
    const body = await c.req.json();

    // Validate required fields
    if (!body.taskId?.trim()) {
      return c.json({ error: "taskId is required" }, 400);
    }
    if (!body.summary?.trim()) {
      return c.json({ error: "summary is required — describe what was done" }, 400);
    }

    const taskId = body.taskId.trim();
    const task = store.getTask(taskId);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }

    // Build the review summary note
    const submittedBy = body.submittedBy?.trim() || task.assignee || task.createdBy || "unknown";

    let summaryContent = body.summary.trim();

    // Append test results if provided
    if (body.testResults) {
      const tr = body.testResults;
      const passed = tr.passed ?? 0;
      const failed = tr.failed ?? 0;
      const skipped = tr.skipped ?? 0;
      const total = passed + failed + skipped;
      const status = failed > 0 ? "FAIL" : "PASS";
      summaryContent += `\n\n[TEST ${status}] ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`;
    }

    // Append concerns if provided
    if (body.concerns?.trim()) {
      summaryContent += `\n\n⚠️ Concerns: ${body.concerns.trim()}`;
    }

    // Set status to in_review
    store.updateTask(taskId, { status: "in_review" });

    // Add structured review note
    store.addNote(taskId, {
      author: submittedBy,
      content: summaryContent,
      type: "update",
    });

    // Attach artifacts
    const artifacts: AddArtifactInput[] = [];

    // Branch artifact
    if (body.branch?.trim()) {
      artifacts.push({
        type: "branch",
        url: body.branch.trim(),
        label: `Branch: ${body.branch.trim()}`,
        addedBy: submittedBy,
      });
    }

    // Explicit artifacts array
    if (Array.isArray(body.artifacts)) {
      for (const a of body.artifacts) {
        if (a.type && a.url && a.label) {
          artifacts.push({
            type: a.type,
            url: a.url,
            label: a.label,
            addedBy: a.addedBy || submittedBy,
          });
        }
      }
    }

    if (artifacts.length > 0) {
      store.addArtifacts(taskId, artifacts);
    }

    const updated = store.getTask(taskId);
    return c.json(updated);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ─── Review Actions ───

// POST /review/:taskId/approve — move to done
reviewRoutes.post("/:taskId/approve", async (c) => {
  try {
    const taskId = c.req.param("taskId");
    const body = await c.req.json().catch(() => ({}));
    const approvedBy = body.approvedBy?.trim() || "dashboard-user";
    const note = body.note?.trim() || "";

    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);

    store.updateTask(taskId, { status: "done" });

    const noteContent = note
      ? `✅ Approved by ${approvedBy}: ${note}`
      : `✅ Approved by ${approvedBy}`;
    store.addNote(taskId, {
      author: approvedBy,
      content: noteContent,
      type: "update",
    });

    return c.json(store.getTask(taskId));
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// POST /review/:taskId/reject — move to open with required note
reviewRoutes.post("/:taskId/reject", async (c) => {
  try {
    const taskId = c.req.param("taskId");
    const body = await c.req.json();
    const rejectedBy = body.rejectedBy?.trim() || "dashboard-user";
    const note = body.note?.trim();

    if (!note) {
      return c.json({ error: "note is required when rejecting" }, 400);
    }

    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);

    store.updateTask(taskId, { status: "open" });

    store.addNote(taskId, {
      author: rejectedBy,
      content: `❌ Rejected by ${rejectedBy}: ${note}`,
      type: "update",
    });

    return c.json(store.getTask(taskId));
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// POST /review/:taskId/changes — request changes, move to in_progress
reviewRoutes.post("/:taskId/changes", async (c) => {
  try {
    const taskId = c.req.param("taskId");
    const body = await c.req.json();
    const requestedBy = body.requestedBy?.trim() || "dashboard-user";
    const note = body.note?.trim();

    if (!note) {
      return c.json({ error: "note is required when requesting changes" }, 400);
    }

    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);

    store.updateTask(taskId, { status: "in_progress" });

    store.addNote(taskId, {
      author: requestedBy,
      content: `🔄 Changes requested by ${requestedBy}: ${note}`,
      type: "update",
    });

    return c.json(store.getTask(taskId));
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// GET /review/queue — list all in_review tasks, enriched
reviewRoutes.get("/queue", (c) => {
  const tasks = store.listTasks({ status: "in_review" });
  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // Enrich each task with parsed review metadata
  const enriched = tasks.map((t) => {
    // Find the review submission note (last "update" note before status changed to in_review)
    const reviewNote = t.notes.length > 0 ? t.notes[t.notes.length - 1] : null;

    // Parse test results from note content
    let testResults = null;
    if (reviewNote?.content) {
      const testMatch = reviewNote.content.match(/\[TEST (PASS|FAIL)\] (\d+)\/(\d+) passed, (\d+) failed, (\d+) skipped/);
      if (testMatch) {
        testResults = {
          status: testMatch[1],
          passed: parseInt(testMatch[2]),
          total: parseInt(testMatch[3]),
          failed: parseInt(testMatch[4]),
          skipped: parseInt(testMatch[5]),
        };
      }
    }

    // Parse concerns
    let concerns = null;
    if (reviewNote?.content) {
      const concernMatch = reviewNote.content.match(/⚠️ Concerns: (.+)$/m);
      if (concernMatch) {
        concerns = concernMatch[1];
      }
    }

    // Clean summary (remove test results and concerns lines)
    let summary = reviewNote?.content || "";
    summary = summary.replace(/\n\n\[TEST (?:PASS|FAIL)\].*$/m, "");
    summary = summary.replace(/\n\n⚠️ Concerns:.*$/m, "");

    return {
      id: t.id,
      title: t.title,
      description: t.description,
      submittedBy: reviewNote?.author || t.assignee || t.createdBy,
      submittedAt: t.updatedAt,
      summary: summary.trim(),
      testResults,
      concerns,
      artifacts: t.artifacts,
      tags: t.tags,
      notes: t.notes,
      score: t.score,
    };
  });

  return c.json({ tasks: enriched, count: enriched.length });
});

// ─── Unified Review Queue ───
// GET /review/unified — single prioritized feed of everything needing human attention

interface ReviewItem {
  id: string;
  type: "task" | "report" | "notification";
  title: string;
  summary: string;
  source: string; // agent name or system
  sourceType: string; // agent persona or notification type
  priority: number; // 0-100, higher = more urgent
  priorityLabel: "critical" | "high" | "normal" | "low";
  createdAt: string;
  waitingSince: string; // when it entered the queue
  waitingMs: number;
  tags: string[];
  artifacts: any[];
  url?: string; // deep link
  raw: any; // original object for frontend to inspect
}

function computePriority(item: {
  tags?: string[];
  priority?: string;
  score?: number;
  createdAt: string;
  updatedAt?: string;
}): { priority: number; priorityLabel: "critical" | "high" | "normal" | "low" } {
  let score = 50; // baseline

  // Tag-based priority
  const tags = item.tags || [];
  if (tags.includes("p0")) score += 30;
  else if (tags.includes("p1")) score += 20;
  else if (tags.includes("p2")) score += 10;
  if (tags.includes("critical")) score += 25;
  if (tags.includes("blocked") || tags.includes("blocker")) score += 15;
  if (tags.includes("safety") || tags.includes("security")) score += 20;

  // Explicit priority field (from notifications)
  if (item.priority === "critical") score += 30;
  else if (item.priority === "high") score += 20;
  else if (item.priority === "low") score -= 15;

  // Bump score from board
  if (item.score && item.score > 0) score += Math.min(item.score * 5, 25);

  // Time decay: items waiting longer get a boost (max +20 after 24h)
  const waitMs = Date.now() - new Date(item.updatedAt || item.createdAt).getTime();
  const waitHours = waitMs / 3600000;
  score += Math.min(Math.floor(waitHours * 0.83), 20);

  // Clamp
  score = Math.max(0, Math.min(100, score));

  let priorityLabel: "critical" | "high" | "normal" | "low";
  if (score >= 80) priorityLabel = "critical";
  else if (score >= 60) priorityLabel = "high";
  else if (score >= 40) priorityLabel = "normal";
  else priorityLabel = "low";

  return { priority: score, priorityLabel };
}

reviewRoutes.get("/unified", (c) => {
  const items: ReviewItem[] = [];
  const now = Date.now();
  const typeFilter = c.req.query("type"); // task, report, notification
  const sourceFilter = c.req.query("source"); // agent name
  const priorityFilter = c.req.query("priority"); // critical, high, normal, low
  const seenIdsParam = c.req.query("seen"); // comma-separated IDs to mark as seen

  // Parse seen IDs from query (client tracks what's been viewed)
  const seenIds = new Set(seenIdsParam ? seenIdsParam.split(",") : []);

  // 1. Board tasks in_review
  if (!typeFilter || typeFilter === "task") {
    const reviewTasks = store.listTasks({ status: "in_review" });
    for (const t of reviewTasks) {
      if (sourceFilter && t.assignee !== sourceFilter && t.createdBy !== sourceFilter) continue;

      const lastNote = t.notes.length > 0 ? t.notes[t.notes.length - 1] : null;
      const { priority, priorityLabel } = computePriority(t);

      if (priorityFilter && priorityLabel !== priorityFilter) continue;

      items.push({
        id: `task:${t.id}`,
        type: "task",
        title: t.title,
        summary: lastNote?.content || t.description || "",
        source: t.assignee || t.createdBy || "unknown",
        sourceType: "agent",
        priority,
        priorityLabel,
        createdAt: t.createdAt,
        waitingSince: t.updatedAt,
        waitingMs: now - new Date(t.updatedAt).getTime(),
        tags: t.tags || [],
        artifacts: t.artifacts || [],
        url: `#review?task=${t.id}`,
        raw: t,
      });
    }
  }

  // 2. Recent reports (last 48h, not tagged 'reviewed')
  if (!typeFilter || typeFilter === "report") {
    const allReports = reportsStore.list();
    const cutoff = new Date(now - 48 * 3600000).toISOString();
    for (const r of allReports) {
      if (r.createdAt < cutoff) continue;
      if ((r.tags || []).includes("reviewed")) continue;
      if (sourceFilter && r.author !== sourceFilter) continue;

      const { priority, priorityLabel } = computePriority({
        tags: r.tags,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });

      if (priorityFilter && priorityLabel !== priorityFilter) continue;

      items.push({
        id: `report:${r.id}`,
        type: "report",
        title: r.title,
        summary: `Report by @${r.author}`,
        source: r.author,
        sourceType: "report",
        priority,
        priorityLabel,
        createdAt: r.createdAt,
        waitingSince: r.createdAt,
        waitingMs: now - new Date(r.createdAt).getTime(),
        tags: r.tags || [],
        artifacts: [{ type: "report", url: r.id, label: r.title }],
        url: `/ui/report/${r.id}`,
        raw: { id: r.id, title: r.title, author: r.author, tags: r.tags, createdAt: r.createdAt },
      });
    }
  }

  // 3. Pending notifications (not dismissed)
  if (!typeFilter || typeFilter === "notification") {
    const { notifications } = notificationStore.getPending();
    for (const n of notifications) {
      if (sourceFilter && n.source !== sourceFilter) continue;

      const { priority, priorityLabel } = computePriority({
        priority: n.priority,
        createdAt: n.createdAt,
      });

      if (priorityFilter && priorityLabel !== priorityFilter) continue;

      items.push({
        id: `notif:${n.id}`,
        type: "notification",
        title: n.title,
        summary: n.body,
        source: n.source,
        sourceType: n.type,
        priority,
        priorityLabel,
        createdAt: n.createdAt,
        waitingSince: n.createdAt,
        waitingMs: now - new Date(n.createdAt).getTime(),
        tags: [],
        artifacts: [],
        url: n.url,
        raw: n,
      });
    }
  }

  // Sort by priority desc, then by waiting time desc
  items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.waitingMs - a.waitingMs;
  });

  // Mark which items are unseen
  const enriched = items.map((item) => ({
    ...item,
    seen: seenIds.has(item.id),
  }));

  // Stats
  const stats = {
    total: enriched.length,
    unseen: enriched.filter((i) => !i.seen).length,
    byType: {
      task: enriched.filter((i) => i.type === "task").length,
      report: enriched.filter((i) => i.type === "report").length,
      notification: enriched.filter((i) => i.type === "notification").length,
    },
    byPriority: {
      critical: enriched.filter((i) => i.priorityLabel === "critical").length,
      high: enriched.filter((i) => i.priorityLabel === "high").length,
      normal: enriched.filter((i) => i.priorityLabel === "normal").length,
      low: enriched.filter((i) => i.priorityLabel === "low").length,
    },
  };

  return c.json({ items: enriched, stats });
});
