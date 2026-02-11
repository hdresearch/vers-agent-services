/**
 * Agent Services Extension
 *
 * Gives pi agents tools to interact with the vers-agent-services coordination
 * layer: shared task board, activity feed, VM registry, and SkillHub.
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
 *
 *   skillhub_sync      — Manually sync skills/extensions from SkillHub
 *
 *   usage_summary      — Get cost & token usage summary
 *   usage_sessions     — List usage session records
 *   usage_vms          — List VM lifecycle records
 *
 * Auto-tracking (no tool calls needed):
 *   - Accumulates tokens & cost from each turn's assistant message usage
 *   - Counts tool calls by tool name
 *   - On agent_end, POSTs session summary to /usage/sessions
 *   - On VM lifecycle tool results, POSTs to /usage/vms
 *
 * SkillHub client:
 *   On session start, syncs enabled skills and extensions from the hub to
 *   ~/.pi/agent/skills/_hub/ and ~/.pi/agent/extensions/_hub/.
 *   Subscribes to SSE stream for real-time updates.
 *
 *   On turn_start (with 60s cooldown), does a lightweight skill-only sync:
 *   fetches the manifest (names + versions), compares locally, and only
 *   downloads changed skills. Extensions are skipped since they require
 *   /reload to take effect.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = process.env.VERS_AUTH_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
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
// SkillHub client — sync skills & extensions from hub to local filesystem
// =============================================================================

const HUB_SKILLS_DIR = join(homedir(), ".pi", "agent", "skills", "_hub");
const HUB_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions", "_hub");

// Cooldown tracking for turn_start skill sync
const TURN_SYNC_COOLDOWN_MS = 60_000; // 60 seconds
let lastTurnSyncAt = 0;

/**
 * Discover skill names already installed from git-based packages.
 * Scans ~/.pi/agent/git/ recursively for skills/X/SKILL.md patterns.
 * These skills should NOT be downloaded from SkillHub to avoid collision warnings.
 */
async function getPackageSkillNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const gitDir = join(homedir(), ".pi", "agent", "git");

  async function walkForSkills(dir: string, depth: number): Promise<void> {
    if (depth > 8) return; // don't recurse too deep
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const s = await stat(full);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === "skills") {
        // Found a skills directory — enumerate its children
        try {
          const skillDirs = await readdir(full);
          for (const skillName of skillDirs) {
            try {
              await stat(join(full, skillName, "SKILL.md"));
              names.add(skillName);
            } catch {
              // not a valid skill dir
            }
          }
        } catch {
          // can't read skills dir
        }
      } else {
        await walkForSkills(full, depth + 1);
      }
    }
  }

  await walkForSkills(gitDir, 0);
  return names;
}

/**
 * Lightweight skill sync for turn_start: fetch manifest (names + versions only),
 * compare against local .version files, and only fetch full content for changed skills.
 * Skips extensions (they need /reload which we can't trigger programmatically yet).
 */
async function syncSkillsLightweight(): Promise<string[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return [];

  const synced: string[] = [];

  try {
    // Step 0: Discover skills already installed from packages (skip these)
    const packageSkills = await getPackageSkillNames();

    // Step 1: Get lightweight manifest (no content, just names + versions)
    const manifest = await api<{
      skills: Array<{ name: string; version: number }>;
      extensions: Array<{ name: string; version: number }>;
    }>("GET", "/skills/manifest");

    // Filter out skills that already exist from installed packages
    const remoteSkills = manifest.skills.filter((s) => !packageSkills.has(s.name));

    await mkdir(HUB_SKILLS_DIR, { recursive: true });

    // Step 2: Compare versions against local state
    const needsUpdate: Array<{ name: string; version: number }> = [];

    for (const skill of remoteSkills) {
      const versionFile = join(HUB_SKILLS_DIR, skill.name, ".version");
      const currentVersion = await readFile(versionFile, "utf-8").catch(() => "0");
      if (parseInt(currentVersion) < skill.version) {
        needsUpdate.push(skill);
      }
    }

    // Step 3: Only fetch full content for skills that changed
    for (const skill of needsUpdate) {
      try {
        const full = await api<{ name: string; version: number; content: string }>(
          "GET",
          `/skills/items/${encodeURIComponent(skill.name)}`,
        );
        const skillDir = join(HUB_SKILLS_DIR, skill.name);
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), full.content);
        await writeFile(join(skillDir, ".version"), String(full.version));
        synced.push(`${full.name} v${full.version}`);
      } catch {
        // Best effort — skip individual skill failures
      }
    }

    // Step 4: Remove hub skills that were deleted from hub or now come from packages
    const hubOnlyNames = new Set(remoteSkills.map((s) => s.name));
    const localDirs = await readdir(HUB_SKILLS_DIR).catch(() => [] as string[]);
    for (const dir of localDirs) {
      if (!hubOnlyNames.has(dir)) {
        await rm(join(HUB_SKILLS_DIR, dir), { recursive: true });
        synced.push(`${dir} (removed)`);
      }
    }
  } catch {
    // Best effort — don't block the turn if hub is unreachable
  }

  return synced;
}

async function syncSkillsFromHub(): Promise<string[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return [];

  const synced: string[] = [];
  const skipped: string[] = [];

  try {
    // Discover skills already installed from packages (skip these)
    const packageSkills = await getPackageSkillNames();

    const res = await api<{ skills: Array<{ name: string; version: number; content: string }>; count: number }>(
      "GET",
      "/skills/items?enabled=true",
    );
    const { skills } = res;

    await mkdir(HUB_SKILLS_DIR, { recursive: true });

    for (const skill of skills) {
      // Skip skills already provided by installed packages
      if (packageSkills.has(skill.name)) {
        skipped.push(skill.name);
        continue;
      }

      const skillDir = join(HUB_SKILLS_DIR, skill.name);
      await mkdir(skillDir, { recursive: true });

      // Check if we already have this version
      const versionFile = join(skillDir, ".version");
      const currentVersion = await readFile(versionFile, "utf-8").catch(() => "0");
      if (parseInt(currentVersion) >= skill.version) continue;

      // Write SKILL.md and version tracker
      await writeFile(join(skillDir, "SKILL.md"), skill.content);
      await writeFile(versionFile, String(skill.version));
      synced.push(`${skill.name} v${skill.version}`);
    }

    // Remove hub skills that were deleted from hub or now come from packages
    const hubOnlyNames = new Set(
      skills.filter((s) => !packageSkills.has(s.name)).map((s) => s.name)
    );
    const localDirs = await readdir(HUB_SKILLS_DIR).catch(() => [] as string[]);
    for (const dir of localDirs) {
      if (!hubOnlyNames.has(dir)) {
        await rm(join(HUB_SKILLS_DIR, dir), { recursive: true });
        synced.push(`${dir} (removed)`);
      }
    }
  } catch {
    // Best effort — don't crash if hub is unreachable
  }

  return synced;
}

async function syncExtensionsFromHub(): Promise<string[]> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return [];

  const synced: string[] = [];

  try {
    const res = await api<{
      extensions: Array<{ name: string; version: number; content: string }>;
      count: number;
    }>("GET", "/skills/extensions?enabled=true");
    const { extensions } = res;

    await mkdir(HUB_EXTENSIONS_DIR, { recursive: true });

    for (const ext of extensions) {
      const extDir = join(HUB_EXTENSIONS_DIR, ext.name);
      await mkdir(extDir, { recursive: true });

      const versionFile = join(extDir, ".version");
      const currentVersion = await readFile(versionFile, "utf-8").catch(() => "0");
      if (parseInt(currentVersion) >= ext.version) continue;

      // Write the extension .ts source
      await writeFile(join(extDir, `${ext.name}.ts`), ext.content);
      await writeFile(versionFile, String(ext.version));
      synced.push(`${ext.name} v${ext.version}`);
    }

    // Remove extensions that were deleted from hub
    const hubNames = new Set(extensions.map((e) => e.name));
    const localDirs = await readdir(HUB_EXTENSIONS_DIR).catch(() => [] as string[]);
    for (const dir of localDirs) {
      if (!hubNames.has(dir)) {
        await rm(join(HUB_EXTENSIONS_DIR, dir), { recursive: true });
        synced.push(`${dir} (removed)`);
      }
    }
  } catch {
    // Best effort — don't crash if hub is unreachable
  }

  return synced;
}

// ---------------------------------------------------------------------------
// SSE stream for real-time skill/extension updates
// ---------------------------------------------------------------------------

let sseAbort: AbortController | null = null;

async function handleSkillEvent(event: { type: string; name: string; kind?: string }): Promise<void> {
  if (event.kind === "extension") {
    // Handle extension events
    const extDir = join(HUB_EXTENSIONS_DIR, event.name);

    if (event.type === "extension_removed") {
      await rm(extDir, { recursive: true, force: true });
      return;
    }

    if (event.type === "extension_published" || event.type === "extension_updated") {
      try {
        const ext = await api<{ name: string; version: number; content: string }>(
          "GET",
          `/skills/extensions/${encodeURIComponent(event.name)}`,
        );
        await mkdir(extDir, { recursive: true });
        await writeFile(join(extDir, `${ext.name}.ts`), ext.content);
        await writeFile(join(extDir, ".version"), String(ext.version));
      } catch {
        // Best effort
      }
    }
    return;
  }

  // Handle skill events — skip skills already installed from packages
  const packageSkills = await getPackageSkillNames();
  if (packageSkills.has(event.name)) return;

  const skillDir = join(HUB_SKILLS_DIR, event.name);

  if (event.type === "skill_removed") {
    await rm(skillDir, { recursive: true, force: true });
    return;
  }

  if (event.type === "skill_published" || event.type === "skill_updated") {
    try {
      const skill = await api<{ name: string; version: number; content: string }>(
        "GET",
        `/skills/items/${encodeURIComponent(event.name)}`,
      );
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), skill.content);
      await writeFile(join(skillDir, ".version"), String(skill.version));
    } catch {
      // Best effort
    }
  }
}

async function startSkillStream(): Promise<void> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return;

  sseAbort = new AbortController();
  const headers: Record<string, string> = {};
  const token = process.env.VERS_AUTH_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(`${baseUrl}/skills/stream`, {
      headers,
      signal: sseAbort.signal,
    });

    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          await handleSkillEvent(event);
        } catch {
          // Skip malformed SSE data
        }
      }
    }
  } catch {
    if (sseAbort?.signal.aborted) return; // intentional disconnect
    // Reconnect after delay
    setTimeout(() => startSkillStream(), 5000);
  }
}

function stopSkillStream(): void {
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // Widget — compact status line, polls every 30s
  // ---------------------------------------------------------------------------
  let widgetTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

    // Start heartbeat
    const vmId = process.env.VERS_VM_ID;
    if (vmId) {
      heartbeatTimer = setInterval(async () => {
        try {
          await api("POST", `/registry/vms/${vmId}/heartbeat`);
        } catch {}
      }, 60_000); // Every 60s
    }

    // Sync skills and extensions from SkillHub
    syncSkillsFromHub().catch(() => {});
    syncExtensionsFromHub().catch(() => {});

    // Subscribe to SSE stream for real-time updates
    startSkillStream();
  });

  // ---------------------------------------------------------------------------
  // turn_start — lightweight skill sync with cooldown
  // ---------------------------------------------------------------------------
  pi.on("turn_start", async () => {
    if (!getBaseUrl()) return;

    const now = Date.now();
    if (now - lastTurnSyncAt < TURN_SYNC_COOLDOWN_MS) return;
    lastTurnSyncAt = now;

    // Fire-and-forget: don't block the turn
    syncSkillsLightweight().catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }

    // Stop SkillHub SSE stream
    stopSkillStream();
  });

  // ---------------------------------------------------------------------------
  // Auto-publish agent_start / agent_end + auto-register in registry
  // ---------------------------------------------------------------------------
  const agentName = process.env.VERS_AGENT_NAME || `agent-${process.pid}`;

  // ---------------------------------------------------------------------------
  // Usage tracking — accumulate tokens, cost, tool calls across the session
  // ---------------------------------------------------------------------------
  let usageSessionId = "";
  let usageModel = "";
  let usageStartedAt = "";
  let usageTurns = 0;
  let usageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let usageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let usageToolCalls: Record<string, number> = {};

  function resetUsageAccumulators() {
    usageStartedAt = new Date().toISOString();
    usageTurns = 0;
    usageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    usageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    usageToolCalls = {};
  }

  // Reset accumulators and capture session metadata on agent start
  pi.on("agent_start", async (_event, ctx) => {
    resetUsageAccumulators();
    usageSessionId = ctx.sessionManager.getSessionId();
    usageModel = ctx.model?.id || "unknown";
  });

  // Accumulate token usage from each turn's assistant message
  pi.on("turn_end", async (event, ctx) => {
    usageTurns++;
    usageModel = ctx.model?.id || usageModel;

    // event.message is AgentMessage — if it's an AssistantMessage it has .usage
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg?.usage) {
      const u = msg.usage;
      usageTokens.input += u.input || 0;
      usageTokens.output += u.output || 0;
      usageTokens.cacheRead += u.cacheRead || 0;
      usageTokens.cacheWrite += u.cacheWrite || 0;
      usageTokens.total += u.totalTokens || 0;

      if (u.cost) {
        usageCost.input += u.cost.input || 0;
        usageCost.output += u.cost.output || 0;
        usageCost.cacheRead += u.cost.cacheRead || 0;
        usageCost.cacheWrite += u.cost.cacheWrite || 0;
        usageCost.total += u.cost.total || 0;
      }
    }
  });

  // Count tool calls by name + track VM lifecycle events
  pi.on("tool_result", async (event) => {
    const toolName = event.toolName;
    usageToolCalls[toolName] = (usageToolCalls[toolName] || 0) + 1;

    // Track VM lifecycle from vers tool results
    if (!getBaseUrl() || event.isError) return;

    try {
      if (toolName === "vers_vm_create" || toolName === "vers_vm_restore") {
        const text = event.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        // Try to extract VM ID from tool result text
        const vmIdMatch = text?.match(/vm[_-]?id["\s:]+["']?([a-zA-Z0-9_-]+)/i)
          || text?.match(/"id"\s*:\s*"([a-f0-9-]{8,})"/)
          || text?.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
        if (vmIdMatch) {
          await api("POST", "/usage/vms", {
            vmId: vmIdMatch[1],
            role: (event.input as any)?.role || "worker",
            agent: agentName,
            commitId: (event.input as any)?.commitId,
            createdAt: new Date().toISOString(),
          }).catch(() => {});
        }
      } else if (toolName === "vers_vm_delete") {
        const inputVmId = (event.input as any)?.vmId;
        const text = event.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        const vmIdMatch = text?.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
        const vmId = inputVmId || vmIdMatch?.[1];
        if (vmId) {
          await api("POST", "/usage/vms", {
            vmId,
            role: "worker",
            agent: agentName,
            createdAt: new Date().toISOString(),
            destroyedAt: new Date().toISOString(),
          }).catch(() => {});
        }
      } else if (toolName === "vers_vm_commit") {
        const inputVmId = (event.input as any)?.vmId;
        if (inputVmId) {
          // Record the commit as a notable VM event (create with commitId)
          const text = event.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          const commitMatch = text?.match(/commit[_-]?id["\s:]+["']?([a-zA-Z0-9_-]+)/i)
            || text?.match(/"commitId"\s*:\s*"([^"]+)"/);
          await api("POST", "/usage/vms", {
            vmId: inputVmId,
            role: "golden",
            agent: agentName,
            commitId: commitMatch?.[1],
            createdAt: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    } catch {
      // best-effort VM tracking
    }
  });

  pi.on("agent_start", async () => {
    if (!getBaseUrl()) return;

    // Auto-publish to feed
    try {
      await api("POST", "/feed/events", {
        agent: agentName,
        type: "agent_started",
        summary: `Agent ${agentName} started processing`,
      });
    } catch {
      // best-effort
    }

    // Auto-register in registry
    try {
      const vmId = process.env.VERS_VM_ID;
      if (vmId) {
        await api("POST", "/registry/vms", {
          id: vmId,
          name: agentName,
          role: process.env.VERS_AGENT_ROLE || "worker",
          address: `${vmId}.vm.vers.sh`,
          registeredBy: agentName,
          metadata: {
            pid: process.pid,
            startedAt: new Date().toISOString(),
          },
        });
      }
    } catch {
      // Best effort — registry might already have this VM, try update instead
      try {
        const vmId = process.env.VERS_VM_ID;
        if (vmId) {
          await api("PATCH", `/registry/vms/${vmId}`, {
            name: agentName,
            status: "running",
          });
        }
      } catch {}
    }
  });

  pi.on("agent_end", async () => {
    if (!getBaseUrl()) return;

    // POST session usage summary
    const endedAt = new Date().toISOString();
    try {
      const roundedCost = {
        input: Math.round(usageCost.input * 1e6) / 1e6,
        output: Math.round(usageCost.output * 1e6) / 1e6,
        cacheRead: Math.round(usageCost.cacheRead * 1e6) / 1e6,
        cacheWrite: Math.round(usageCost.cacheWrite * 1e6) / 1e6,
        total: Math.round(usageCost.total * 1e6) / 1e6,
      };
      await api("POST", "/usage/sessions", {
        sessionId: usageSessionId || `session-${Date.now()}`,
        agent: agentName,
        parentAgent: process.env.VERS_PARENT_AGENT || null,
        model: usageModel,
        tokens: { ...usageTokens },
        cost: roundedCost,
        turns: usageTurns,
        toolCalls: { ...usageToolCalls },
        startedAt: usageStartedAt || endedAt,
        endedAt,
      });
    } catch {
      // best-effort — don't block agent shutdown
    }

    // Auto-publish to feed (enriched with usage data)
    try {
      const costStr = (Math.round(usageCost.total * 100) / 100).toFixed(2);
      await api("POST", "/feed/events", {
        agent: agentName,
        type: "agent_stopped",
        summary: `Agent ${agentName} finished (${usageTurns} turns, ${usageTokens.total} tokens, $${costStr})`,
      });
    } catch {
      // best-effort
    }

    // Update registry status
    try {
      const vmId = process.env.VERS_VM_ID;
      if (vmId) {
        await api("PATCH", `/registry/vms/${vmId}`, { status: "stopped" });
      }
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // Auto-heartbeat — keeps registry entry alive while agent is running
  // (heartbeatTimer declared above with widgetTimer, started in session_start)
  // ---------------------------------------------------------------------------

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
        StringEnum(["open", "in_progress", "in_review", "blocked", "done"] as const, {
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
        StringEnum(["open", "in_progress", "in_review", "blocked", "done"] as const, {
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

  pi.registerTool({
    name: "board_submit_for_review",
    label: "Board: Submit for Review",
    description:
      "Submit a task for review — sets status to in_review, adds a summary note, and optionally attaches artifacts.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to submit for review" }),
      summary: Type.String({ description: "Review summary describing what was done" }),
      artifacts: Type.Optional(
        Type.Array(
          Type.Object({
            type: StringEnum(["branch", "report", "deploy", "diff", "file", "url"] as const, {
              description: "Artifact type",
            }),
            url: Type.String({ description: "URL or path to the artifact" }),
            label: Type.String({ description: "Human-readable label for the artifact" }),
          }),
          { description: "Artifacts to attach" },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const body: Record<string, unknown> = {
          summary: params.summary,
          reviewedBy: agentName,
        };
        if (params.artifacts) body.artifacts = params.artifacts;
        const task = await api(
          "POST",
          `/board/tasks/${encodeURIComponent(params.taskId)}/review`,
          body,
        );
        return ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_add_artifact",
    label: "Board: Add Artifact",
    description:
      "Add artifact link(s) to any task — branches, reports, deploys, diffs, files, or URLs.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to add artifacts to" }),
      artifacts: Type.Array(
        Type.Object({
          type: StringEnum(["branch", "report", "deploy", "diff", "file", "url"] as const, {
            description: "Artifact type",
          }),
          url: Type.String({ description: "URL or path to the artifact" }),
          label: Type.String({ description: "Human-readable label for the artifact" }),
        }),
        { description: "Artifacts to attach" },
      ),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const task = await api(
          "POST",
          `/board/tasks/${encodeURIComponent(params.taskId)}/artifacts`,
          { artifacts: params.artifacts.map((a) => ({ ...a, addedBy: agentName })) },
        );
        return ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  // ===========================================================================
  // Log Tools
  // ===========================================================================

  pi.registerTool({
    name: "log_append",
    label: "Log: Append Entry",
    description:
      "Append a work log entry — timestamped, append-only. Like Carmack's .plan file.",
    parameters: Type.Object({
      text: Type.String({ description: "Log entry text" }),
      agent: Type.Optional(Type.String({ description: "Who is writing this entry (agent name)" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const entry = await api("POST", "/log", params);
        return ok(JSON.stringify(entry, null, 2), { entry });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "log_query",
    label: "Log: Query Entries",
    description:
      "Query the work log. Returns timestamped entries filtered by time range. Use raw=true for plain text output suitable for piping into models.",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "Start time (ISO timestamp)" })),
      until: Type.Optional(Type.String({ description: "End time (ISO timestamp)" })),
      last: Type.Optional(Type.String({ description: 'Duration shorthand, e.g. "24h", "7d", "30d"' })),
      raw: Type.Optional(Type.Boolean({ description: "Return plain text instead of JSON (default: false)" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.since) qs.set("since", params.since);
        if (params.until) qs.set("until", params.until);
        if (params.last) qs.set("last", params.last);
        const query = qs.toString();
        const endpoint = params.raw ? "/log/raw" : "/log";
        const result = await api("GET", `${endpoint}${query ? `?${query}` : ""}`);
        if (params.raw && typeof result === "string") {
          return ok(result || "(no entries)");
        }
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  // ===========================================================================
  // Journal Tools
  // ===========================================================================

  pi.registerTool({
    name: "journal_entry",
    label: "Journal: Write Entry",
    description:
      "Write a personal journal entry — thoughts, vibes, product intuitions, feelings. NOT for operational tasks (use log_append for that).",
    parameters: Type.Object({
      text: Type.String({ description: "Journal entry text" }),
      mood: Type.Optional(Type.String({ description: "Optional mood/vibe tag" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const body: Record<string, unknown> = { text: params.text, author: agentName };
        if (params.mood) body.mood = params.mood;
        if (params.tags) body.tags = params.tags;
        const entry = await api("POST", "/journal", body);
        return ok(JSON.stringify(entry, null, 2), { entry });
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

  // ===========================================================================
  // SkillHub Tools
  // ===========================================================================

  pi.registerTool({
    name: "skillhub_sync",
    label: "Sync SkillHub",
    description:
      "Pull latest skills and extensions from the SkillHub. Happens automatically on session start, but can be triggered manually.",
    parameters: Type.Object({}),
    async execute() {
      if (!getBaseUrl()) return noUrlError();
      try {
        const packageSkills = await getPackageSkillNames();
        const synced = await syncSkillsFromHub();
        const extsSynced = await syncExtensionsFromHub();
        const total = synced.length + extsSynced.length;
        const skippedNote = packageSkills.size > 0
          ? `\nSkipped (from packages): ${Array.from(packageSkills).join(", ")}`
          : "";
        const text =
          total > 0
            ? `Synced from hub:\nSkills: ${synced.join(", ") || "up to date"}\nExtensions: ${extsSynced.join(", ") || "up to date"}${skippedNote}${extsSynced.length > 0 ? "\n\nNote: Extension changes require /reload to take effect." : ""}`
            : `Everything up to date.${skippedNote}`;
        return ok(text, { skills: synced, extensions: extsSynced, skippedFromPackages: Array.from(packageSkills) });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  // ===========================================================================
  // Usage Tools
  // ===========================================================================

  pi.registerTool({
    name: "usage_summary",
    label: "Usage: Summary",
    description:
      "Get cost & token usage summary across the agent fleet. Returns totals and per-agent breakdown.",
    parameters: Type.Object({
      range: Type.Optional(
        Type.String({ description: 'Time range, e.g. "7d", "30d", "24h" (default: "7d")' }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.range) qs.set("range", params.range);
        const query = qs.toString();
        const result = await api("GET", `/usage${query ? `?${query}` : ""}`);
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "usage_sessions",
    label: "Usage: Sessions",
    description:
      "List session usage records. Shows tokens, cost, turns, and tool calls per session.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      range: Type.Optional(
        Type.String({ description: 'Time range, e.g. "7d", "30d", "24h"' }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.agent) qs.set("agent", params.agent);
        if (params.range) qs.set("range", params.range);
        const query = qs.toString();
        const result = await api("GET", `/usage/sessions${query ? `?${query}` : ""}`);
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "usage_vms",
    label: "Usage: VMs",
    description:
      "List VM lifecycle records — creation, commit, and destruction events.",
    parameters: Type.Object({
      role: Type.Optional(
        StringEnum(["orchestrator", "lieutenant", "worker", "infra", "golden"] as const, {
          description: "Filter by VM role",
        }),
      ),
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      range: Type.Optional(
        Type.String({ description: 'Time range, e.g. "7d", "30d", "24h"' }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!getBaseUrl()) return noUrlError();
      try {
        const qs = new URLSearchParams();
        if (params.role) qs.set("role", params.role);
        if (params.agent) qs.set("agent", params.agent);
        if (params.range) qs.set("range", params.range);
        const query = qs.toString();
        const result = await api("GET", `/usage/vms${query ? `?${query}` : ""}`);
        return ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return err(e.message);
      }
    },
  });
}
