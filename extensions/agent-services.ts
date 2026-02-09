/**
 * Agent Services Extension
 *
 * Gives pi agents tools to interact with the vers-agent-services coordination
 * layer: shared task board, activity feed, and VM registry.
 *
 * Configuration:
 *   VERS_INFRA_URL — Base URL of the running vers-agent-services instance
 *                    (e.g. http://localhost:3000)
 *
 * Tools provided:
 *   board_create_task  — Create a task on the shared board
 *   board_list_tasks   — List/filter tasks
 *   board_update_task  — Update task status, assignee, etc.
 *   board_add_note     — Add a note to a task
 *
 *   feed_publish       — Publish an event to the activity feed
 *   feed_list          — List/filter feed events
 *   feed_stats         — Get feed summary statistics
 *
 *   registry_list      — List registered VMs
 *   registry_register  — Register a VM in the registry
 *   registry_discover  — Discover VMs by role
 *   registry_heartbeat — Send a heartbeat for a VM
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// =============================================================================
// HTTP client helpers
// =============================================================================

function getBaseUrl(): string | null {
  return process.env.VERS_INFRA_URL || null;
}

function noUrlError() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Error: VERS_INFRA_URL environment variable is not set.\n\nSet it to the base URL of your vers-agent-services instance, e.g.:\n  export VERS_INFRA_URL=http://localhost:3000",
      },
    ],
    isError: true,
  };
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const base = getBaseUrl();
  if (!base) throw new Error("VERS_INFRA_URL not set");

  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in (data as Record<string, unknown>)
        ? (data as { error: string }).error
        : text;
    throw new Error(`${method} ${path} (${res.status}): ${msg}`);
  }

  return data as T;
}

function ok(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

function err(text: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    isError: true,
  };
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // Widget — compact status line, polls every 30s
  // ---------------------------------------------------------------------------
  let widgetTimer: ReturnType<typeof setInterval> | null = null;

  async function updateWidget(ctx: { ui: { setWidget: Function } }) {
    const base = getBaseUrl();
    if (!base) return;

    try {
      const [boardRes, feedRes, registryRes] = await Promise.all([
        api<{ tasks: { status: string }[]; count: number }>("GET", "/board/tasks"),
        api<{ total: number }>("GET", "/feed/stats"),
        api<{ vms: { status: string }[]; count: number }>("GET", "/registry/vms"),
      ]);

      const open = boardRes.tasks.filter((t) => t.status === "open").length;
      const blocked = boardRes.tasks.filter((t) => t.status === "blocked").length;
      const inProgress = boardRes.tasks.filter((t) => t.status === "in_progress").length;

      const total = registryRes.count;
      const running = registryRes.vms.filter((v) => v.status === "running").length;

      const lines = [
        "─── Agent Services ───",
        `Board: ${open} open, ${inProgress} in-progress, ${blocked} blocked`,
        `Feed: ${feedRes.total} events`,
        `Registry: ${total} VMs (${running} running)`,
      ];
      ctx.ui.setWidget("agent-services", lines);
    } catch {
      // Silently ignore — widget is best-effort
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!getBaseUrl()) return;
    updateWidget(ctx);
    widgetTimer = setInterval(() => updateWidget(ctx), 30_000);
  });

  pi.on("session_shutdown", async () => {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-publish agent_start / agent_end to the feed
  // ---------------------------------------------------------------------------
  const agentName = process.env.VERS_AGENT_NAME || `agent-${process.pid}`;

  pi.on("agent_start", async () => {
    if (!getBaseUrl()) return;
    try {
      await api("POST", "/feed/events", {
        agent: agentName,
        type: "agent_started",
        summary: `Agent ${agentName} started processing`,
      });
    } catch {
      // best-effort
    }
  });

  pi.on("agent_end", async () => {
    if (!getBaseUrl()) return;
    try {
      await api("POST", "/feed/events", {
        agent: agentName,
        type: "agent_stopped",
        summary: `Agent ${agentName} finished processing`,
      });
    } catch {
      // best-effort
    }
  });

  // ===========================================================================
  // Board Tools
  // ===========================================================================

  pi.registerTool({
    name: "board_create_task",
    label: "Board: Create Task",
    description:
      "Create a new task on the shared coordination board. Returns the created task with its ID.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(Type.String({ description: "Detailed task description" })),
      assignee: Type.Optional(Type.String({ description: "Agent or user to assign the task to" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      createdBy: Type.String({ description: "Who is creating this task (agent name)" }),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const task = await api("POST", "/board/tasks", params);
        return ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_list_tasks",
    label: "Board: List Tasks",
    description:
      "List tasks on the shared board. Optionally filter by status, assignee, or tag.",
    parameters: Type.Object({
      status: Type.Optional(
        StringEnum(["open", "in_progress", "blocked", "done"] as const, {
          description: "Filter by task status",
        }),
      ),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee" })),
      tag: Type.Optional(Type.String({ description: "Filter by tag" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.status) qs.set("status", params.status);
        if (params.assignee) qs.set("assignee", params.assignee);
        if (params.tag) qs.set("tag", params.tag);
        const query = qs.toString();
        const result = await api("GET", `/board/tasks${query ? `?${query}` : ""}`);
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_update_task",
    label: "Board: Update Task",
    description:
      "Update a task on the board — change status, reassign, rename, or update tags.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(
        StringEnum(["open", "in_progress", "blocked", "done"] as const, {
          description: "New status",
        }),
      ),
      assignee: Type.Optional(Type.String({ description: "New assignee" })),
      title: Type.Optional(Type.String({ description: "New title" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const { id, ...updates } = params;
        const task = await api("PATCH", `/board/tasks/${encodeURIComponent(id)}`, updates);
        return ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_add_note",
    label: "Board: Add Note",
    description:
      "Add a note to a task — findings, blockers, questions, or status updates.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to add the note to" }),
      author: Type.String({ description: "Who is writing this note (agent name)" }),
      content: Type.String({ description: "Note content" }),
      type: StringEnum(["finding", "blocker", "question", "update"] as const, {
        description: "Note type",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const { taskId, ...body } = params;
        const note = await api(
          "POST",
          `/board/tasks/${encodeURIComponent(taskId)}/notes`,
          body,
        );
        return ok(JSON.stringify(note, null, 2), { note });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  // ===========================================================================
  // Feed Tools
  // ===========================================================================

  pi.registerTool({
    name: "feed_publish",
    label: "Feed: Publish Event",
    description:
      "Publish an event to the activity feed. Used for coordination, progress reporting, and audit trails.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name publishing the event" }),
      type: StringEnum(
        [
          "task_started",
          "task_completed",
          "task_failed",
          "blocker_found",
          "question",
          "finding",
          "skill_proposed",
          "file_changed",
          "cost_update",
          "agent_started",
          "agent_stopped",
          "custom",
        ] as const,
        { description: "Event type" },
      ),
      summary: Type.String({ description: "Short human-readable summary" }),
      detail: Type.Optional(Type.String({ description: "Longer detail or structured data" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const event = await api("POST", "/feed/events", params);
        return ok(JSON.stringify(event, null, 2), { event });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "feed_list",
    label: "Feed: List Events",
    description: "List recent activity feed events. Optionally filter by agent, type, or limit.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      type: Type.Optional(Type.String({ description: "Filter by event type" })),
      limit: Type.Optional(Type.Number({ description: "Max events to return (default 50)" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.agent) qs.set("agent", params.agent);
        if (params.type) qs.set("type", params.type);
        if (params.limit) qs.set("limit", String(params.limit));
        const query = qs.toString();
        const result = await api("GET", `/feed/events${query ? `?${query}` : ""}`);
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "feed_stats",
    label: "Feed: Stats",
    description: "Get summary statistics of the activity feed — total events, events by type, etc.",
    parameters: Type.Object({}),
    async execute() {
      if (!getBaseUrl()) return noUrlError();
      try {
        const stats = await api("GET", "/feed/stats");
        return ok(JSON.stringify(stats, null, 2), { stats });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  // ===========================================================================
  // Registry Tools
  // ===========================================================================

  pi.registerTool({
    name: "registry_list",
    label: "Registry: List VMs",
    description: "List VMs in the coordination registry. Optionally filter by role or status.",
    parameters: Type.Object({
      role: Type.Optional(
        StringEnum(["infra", "lieutenant", "worker", "golden", "custom"] as const, {
          description: "Filter by role",
        }),
      ),
      status: Type.Optional(
        StringEnum(["running", "paused", "stopped"] as const, {
          description: "Filter by status",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.role) qs.set("role", params.role);
        if (params.status) qs.set("status", params.status);
        const query = qs.toString();
        const result = await api("GET", `/registry/vms${query ? `?${query}` : ""}`);
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_register",
    label: "Registry: Register VM",
    description:
      "Register a VM in the coordination registry so other agents can discover it.",
    parameters: Type.Object({
      id: Type.String({ description: "VM ID (from Vers)" }),
      name: Type.String({ description: "Human-readable name for this VM" }),
      role: StringEnum(["infra", "lieutenant", "worker", "golden", "custom"] as const, {
        description: "VM role in the swarm",
      }),
      address: Type.String({ description: "Network address or endpoint for this VM" }),
      services: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            port: Type.Number(),
            protocol: Type.Optional(Type.String()),
          }),
          { description: "Services exposed by this VM" },
        ),
      ),
      registeredBy: Type.String({ description: "Who is registering this VM (agent name)" }),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const vm = await api("POST", "/registry/vms", params);
        return ok(JSON.stringify(vm, null, 2), { vm });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_discover",
    label: "Registry: Discover VMs",
    description:
      "Discover VMs by role — find workers, lieutenants, or other agents in the swarm.",
    parameters: Type.Object({
      role: StringEnum(["infra", "lieutenant", "worker", "golden", "custom"] as const, {
        description: "Role to search for",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const result = await api(
          "GET",
          `/registry/discover/${encodeURIComponent(params.role)}`,
        );
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_heartbeat",
    label: "Registry: Heartbeat",
    description: "Send a heartbeat to keep a VM's registration active.",
    parameters: Type.Object({
      id: Type.String({ description: "VM ID to heartbeat" }),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const result = await api(
          "POST",
          `/registry/vms/${encodeURIComponent(params.id)}/heartbeat`,
        );
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });
}
