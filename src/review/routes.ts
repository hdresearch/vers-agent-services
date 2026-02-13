import { Hono } from "hono";
import {
  NotFoundError,
  ValidationError,
  type AddArtifactInput,
} from "../board/store.js";
import { boardStore as store } from "../board/shared-store.js";

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
