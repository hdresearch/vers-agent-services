/**
 * Chat-to-Action Bridge
 *
 * Parses slash commands from web chat messages and executes them
 * via internal HTTP calls to agent-services endpoints.
 * Posts results back to chat as system/bridge messages.
 */

import { WebChatStore, type WebChatMessage } from "./store.js";

const AUTH_TOKEN = process.env.VERS_AUTH_TOKEN || "test-token";

// ── Command definitions ────────────────────────────────────────────────────

export interface CommandDef {
  name: string;
  usage: string;
  description: string;
  examples: string[];
}

export const COMMANDS: CommandDef[] = [
  {
    name: "spawn",
    usage: "/spawn <persona> <task>",
    description: "Queue a spawn request for the orchestrator",
    examples: ["/spawn ada deploy the new config service", "/spawn rei review the chat bridge PR"],
  },
  {
    name: "status",
    usage: "/status",
    description: "Fleet status: VMs, agents, board summary, costs",
    examples: ["/status"],
  },
  {
    name: "board",
    usage: "/board [filter]",
    description: "Show board tasks. Optional filter: open, blocked, in_progress, done",
    examples: ["/board", "/board blocked", "/board open"],
  },
  {
    name: "reap",
    usage: "/reap",
    description: "Trigger Charon to reap stale/zombie VMs",
    examples: ["/reap"],
  },
  {
    name: "deploy",
    usage: "/deploy [branch]",
    description: "Trigger a deploy (posts to CI webhook)",
    examples: ["/deploy", "/deploy feat/chat-bridge"],
  },
  {
    name: "notify",
    usage: "/notify <message>",
    description: "Send a notification to all connected dashboards",
    examples: ["/notify deployment starting in 5 minutes"],
  },
  {
    name: "help",
    usage: "/help",
    description: "Show available commands",
    examples: ["/help"],
  },
];

// ── Internal API caller ────────────────────────────────────────────────────

function getBaseUrl(): string {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: (err as Error).message } };
  }
}

// ── Command parsers ────────────────────────────────────────────────────────

export interface ParsedCommand {
  name: string;
  args: string;
  raw: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: "", raw: trimmed };
  }
  return {
    name: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
    raw: trimmed,
  };
}

// ── Command executors ──────────────────────────────────────────────────────

async function execSpawn(args: string): Promise<string> {
  if (!args.trim()) return "Usage: /spawn <persona> <task>";
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) return "Usage: /spawn <persona> <task description>";
  const persona = args.slice(0, spaceIdx).trim();
  const task = args.slice(spaceIdx + 1).trim();
  if (!task) return "Usage: /spawn <persona> <task description>";

  // Create a board task tagged for spawn
  const { ok, data } = await apiCall("POST", "/board/tasks", {
    title: `[spawn] ${persona}: ${task}`,
    createdBy: "chat-bridge",
    assignee: persona,
    tags: ["from-chat", "spawn-request"],
    metadata: { persona, task, source: "web-chat" },
  });

  if (!ok) return `✗ Failed to queue spawn: ${data.error || "unknown error"}`;

  // Also post to feed so orchestrator can see it
  await apiCall("POST", "/feed/events", {
    agent: "chat-bridge",
    type: "task_assigned",
    summary: `Spawn request: ${persona} → ${task}`,
    metadata: { taskId: data.id, persona, task },
  });

  return `✓ Spawn queued — task ${data.id}\n  persona: ${persona}\n  task: ${task}`;
}

async function execStatus(): Promise<string> {
  const parts: string[] = ["═══ Fleet Status ═══"];

  // Registry
  const reg = await apiCall("GET", "/registry/vms");
  if (reg.ok) {
    const vms = reg.data.vms || [];
    const active = vms.filter((v: any) => v.status === "running" || v.status === "active");
    parts.push(`\nVMs: ${vms.length} registered, ${active.length} active`);
    for (const vm of vms.slice(0, 8)) {
      const ago = timeSince(vm.lastSeen || vm.registeredAt);
      parts.push(`  ${vm.name || vm.id} [${vm.role}] ${vm.status || "?"} — seen ${ago}`);
    }
  } else {
    parts.push("\nVMs: failed to fetch");
  }

  // Board summary
  const board = await apiCall("GET", "/board/tasks");
  if (board.ok) {
    const tasks = board.data.tasks || [];
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    parts.push(
      `\nBoard: ${tasks.length} tasks — ` +
        `${counts.open || 0} open, ${counts.in_progress || 0} in progress, ` +
        `${counts.blocked || 0} blocked, ${counts.done || 0} done`,
    );
  }

  // Usage
  const usage = await apiCall("GET", "/usage/summary?range=24h");
  if (usage.ok && usage.data.totals) {
    const t = usage.data.totals;
    if (t.cost != null) parts.push(`\nCost (24h): $${Number(t.cost).toFixed(4)}`);
    if (t.tokens != null) parts.push(`Tokens (24h): ${Number(t.tokens).toLocaleString()}`);
  }

  return parts.join("\n");
}

async function execBoard(args: string): Promise<string> {
  const statusFilter = args.trim() || undefined;
  const query = statusFilter ? `?status=${statusFilter}` : "";
  const { ok, data } = await apiCall("GET", `/board/tasks${query}`);

  if (!ok) return `✗ Failed to fetch board: ${data.error || "unknown"}`;

  const tasks = data.tasks || [];
  if (tasks.length === 0) return statusFilter ? `No ${statusFilter} tasks.` : "Board is empty.";

  const lines: string[] = [`═══ Board${statusFilter ? ` (${statusFilter})` : ""} — ${tasks.length} tasks ═══`];

  // Group by status
  const grouped: Record<string, any[]> = {};
  for (const t of tasks) {
    (grouped[t.status] ||= []).push(t);
  }

  for (const [status, items] of Object.entries(grouped)) {
    lines.push(`\n[${status}] — ${items.length}`);
    for (const t of items.slice(0, 5)) {
      const assignee = t.assignee ? ` → @${t.assignee}` : "";
      lines.push(`  • ${t.title}${assignee}`);
    }
    if (items.length > 5) lines.push(`  ... and ${items.length - 5} more`);
  }

  return lines.join("\n");
}

async function execReap(): Promise<string> {
  // Check for stale VMs
  const stale = await apiCall("GET", "/registry/stale");
  if (!stale.ok) return `✗ Failed to check stale VMs: ${stale.data.error || "unknown"}`;

  const staleVms = stale.data.vms || [];
  if (staleVms.length === 0) return "✓ No stale VMs to reap.";

  // Purge stale VMs
  const purge = await apiCall("DELETE", "/registry/stale");
  if (!purge.ok) return `✗ Failed to purge: ${purge.data.error || "unknown"}`;

  // Also post a notification
  await apiCall("POST", "/notifications", {
    type: "alert",
    title: "Reap complete",
    body: `Purged ${purge.data.purged || 0} stale VMs`,
    source: "chat-bridge",
    priority: "normal",
  });

  // Post to feed
  await apiCall("POST", "/feed/events", {
    agent: "chat-bridge",
    type: "task_completed",
    summary: `Reaped ${purge.data.purged || 0} stale VMs: ${staleVms.map((v: any) => v.name || v.id).join(", ")}`,
  });

  const names = staleVms.map((v: any) => `  • ${v.name || v.id} [${v.role}]`).join("\n");
  return `✓ Reaped ${purge.data.purged || 0} stale VMs:\n${names}`;
}

async function execDeploy(args: string): Promise<string> {
  const branch = args.trim() || "main";

  // Post to feed about deploy intent
  await apiCall("POST", "/feed/events", {
    agent: "chat-bridge",
    type: "deploy_started",
    summary: `Deploy triggered from chat: branch=${branch}`,
  });

  // Create a board task for tracking
  const { ok, data } = await apiCall("POST", "/board/tasks", {
    title: `[deploy] Deploy branch: ${branch}`,
    createdBy: "chat-bridge",
    tags: ["deploy", "from-chat"],
    metadata: { branch, source: "web-chat" },
  });

  if (!ok) return `✗ Failed to create deploy task: ${data.error || "unknown"}`;

  // Notify dashboards
  await apiCall("POST", "/notifications", {
    type: "alert",
    title: "Deploy requested",
    body: `Branch: ${branch} — queued for deployment`,
    source: "chat-bridge",
    priority: "high",
  });

  return `✓ Deploy queued — branch: ${branch}\n  task: ${data.id}\n  Waiting for orchestrator pickup.`;
}

async function execNotify(args: string): Promise<string> {
  if (!args.trim()) return "Usage: /notify <message>";

  const { ok, data } = await apiCall("POST", "/notifications", {
    type: "chat",
    title: "Chat notification",
    body: args.trim(),
    source: "chat-bridge",
    priority: "normal",
  });

  if (!ok) return `✗ Failed to send notification: ${data.error || "unknown"}`;
  return `✓ Notification sent: ${data.id}`;
}

function execHelp(): string {
  const lines = ["═══ Chat Bridge Commands ═══\n"];
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.usage}`);
    lines.push(`    ${cmd.description}`);
  }
  lines.push("\nAnything without a / prefix is posted as a human message visible to agents.");
  return lines.join("\n");
}

// ── Utility ────────────────────────────────────────────────────────────────

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ── Bridge engine ──────────────────────────────────────────────────────────

export class ChatBridge {
  private store: WebChatStore;
  private running = false;
  private removeListener?: () => void;

  constructor(store: WebChatStore) {
    this.store = store;
  }

  /** Start watching for new messages and executing commands. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.removeListener = this.store.addListener(async (msg) => {
      // Only process human messages that look like commands
      if (msg.role !== "human") return;
      await this.processMessage(msg);
    });
  }

  stop(): void {
    this.running = false;
    if (this.removeListener) {
      this.removeListener();
      this.removeListener = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Process a single message — execute command or acknowledge free-text. */
  async processMessage(msg: WebChatMessage): Promise<void> {
    const parsed = parseCommand(msg.content);

    if (!parsed) {
      // Free-text: post to work log so agents can see it
      await apiCall("POST", "/log", {
        text: msg.content,
        agent: msg.sender || "noah",
      });

      // Also post to feed
      await apiCall("POST", "/feed/events", {
        agent: msg.sender || "noah",
        type: "human_message",
        summary: msg.content.slice(0, 200),
      });
      return;
    }

    // Execute the command
    let result: string;
    try {
      switch (parsed.name) {
        case "spawn":
          result = await execSpawn(parsed.args);
          break;
        case "status":
          result = await execStatus();
          break;
        case "board":
          result = await execBoard(parsed.args);
          break;
        case "reap":
          result = await execReap();
          break;
        case "deploy":
          result = await execDeploy(parsed.args);
          break;
        case "notify":
          result = await execNotify(parsed.args);
          break;
        case "help":
          result = execHelp();
          break;
        default:
          result = `Unknown command: /${parsed.name}. Type /help for available commands.`;
      }
    } catch (err) {
      result = `✗ Command failed: ${(err as Error).message}`;
    }

    // Post result back as a bridge message
    this.store.post({
      role: "bridge",
      sender: "bridge",
      content: result,
      command: parsed.name,
      metadata: { inResponseTo: msg.id, rawCommand: parsed.raw },
    });
  }

  /** Post a system/fleet event into the chat. */
  postFleetEvent(summary: string, source: string, metadata?: Record<string, unknown>): void {
    this.store.post({
      role: "system",
      sender: source,
      content: summary,
      metadata,
    });
  }
}
