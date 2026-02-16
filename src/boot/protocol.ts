/**
 * Boot Protocol — The identity & orientation layer for freshly-spawned agents.
 *
 * When an agent wakes from a golden image, it has tools but no identity,
 * no context, no memory. The boot protocol gives it all three.
 */

import { cryoStore } from "../cryo/routes.js";
import { store as personaStore } from "../personas/routes.js";
import { registryStore } from "../registry/routes.js";
import { kbStore } from "../kb/routes.js";
import { feedStore } from "../feed/routes.js";
import { store as boardStore } from "../board/routes.js";
import { fleetChatStore } from "../fleet-chat/routes.js";
import { emit } from "../events/emit.js";
import type { CryoAgent } from "../cryo/store.js";
import type { Persona } from "../personas/store.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface RegisterInput {
  vmId: string;
  name?: string;
  taskHint?: string;
}

export interface BootIdentity {
  identity: CryoAgent;
  persona: Persona | null;
  kbBriefing: unknown[];
  recentLog: unknown[];
  boardTasks: unknown[];
  fleetStatus: {
    activeVMs: number;
    activeAgents: number;
    vms: unknown[];
  };
}

export interface DebriefInput {
  agentName: string;
  summary: string;
  artifacts?: Array<{ type: string; uri: string; label?: string }>;
  commitId?: string;
}

export interface BriefingResult {
  identity: CryoAgent | null;
  persona: Persona | null;
  kbBriefing: unknown[];
  recentFeed: unknown[];
  boardTasks: unknown[];
  fleetStatus: {
    activeVMs: number;
    activeAgents: number;
    vms: unknown[];
  };
  fleetChat: unknown[];
  cryoHistory: unknown[];
}

// ── Protocol Functions ─────────────────────────────────────────────────

/**
 * Register an agent on first wake. Restores or assigns identity.
 */
export function registerAgent(input: RegisterInput): BootIdentity {
  const { vmId, name, taskHint } = input;

  if (!vmId || typeof vmId !== "string") {
    throw new Error("vmId is required");
  }

  let agent: CryoAgent;
  let persona: Persona | null = null;

  if (name) {
    // Named agent — try to restore from cryochamber
    try {
      agent = cryoStore.getAgent(name);
      // Wake if hibernating
      if (agent.status === "hibernating") {
        agent = cryoStore.wake(name, { vmId, briefing: taskHint });
      } else {
        // Already awake or just update VM
        cryoStore.updateAgent(name, { currentVmId: vmId, status: "awake" });
        agent = cryoStore.getAgent(name);
      }
    } catch {
      // Agent doesn't exist in cryo — pick a persona and create
      persona = pickPersona(taskHint);
      agent = cryoStore.createAgent({
        name,
        persona: persona?.name || "default",
        currentVmId: vmId,
        status: "awake",
        briefing: taskHint || undefined,
      });
    }

    // Resolve persona
    if (!persona && agent.persona) {
      persona = personaStore.getPersona(agent.persona) || null;
    }
  } else {
    // No name — assign from available personas
    persona = pickPersona(taskHint);
    const assignedName = generateAgentName(persona);

    agent = cryoStore.createAgent({
      name: assignedName,
      persona: persona?.name || "default",
      currentVmId: vmId,
      status: "awake",
      briefing: taskHint || undefined,
    });
  }

  // Register in the VM registry too
  try {
    registryStore.register({
      id: vmId,
      name: agent.name,
      role: "worker",
      address: vmId,
      registeredBy: agent.name,
    });
  } catch {
    // May already be registered — update heartbeat instead
    try {
      registryStore.heartbeat(vmId);
    } catch {
      // ignore
    }
  }

  emit("boot", "boot.agent.registered", {
    agentName: agent.name,
    vmId,
    persona: agent.persona,
    restored: !!name,
  }, agent.name);

  // Gather briefing data
  const kbBriefing = getKBBriefing();
  const recentLog = getRecentFeed(2);
  const boardTasks = getBoardTasks(agent.name);
  const fleetStatus = getFleetStatus();

  return { identity: agent, persona, kbBriefing, recentLog, boardTasks, fleetStatus };
}

/**
 * Full briefing for a named agent — everything needed to orient.
 */
export function getBriefing(agentName: string): BriefingResult {
  let identity: CryoAgent | null = null;
  let persona: Persona | null = null;

  try {
    identity = cryoStore.getAgent(agentName);
    if (identity.persona) {
      persona = personaStore.getPersona(identity.persona) || null;
    }
  } catch {
    // Agent not in cryo — that's okay, return what we can
  }

  const kbBriefing = getKBBriefing();
  const recentFeed = getRecentFeed(2);
  const boardTasks = getBoardTasks(agentName);
  const fleetStatus = getFleetStatus();
  const fleetChat = getRecentFleetChat();
  const cryoHistory = identity ? getCryoHistory(agentName) : [];

  return {
    identity,
    persona,
    kbBriefing,
    recentFeed,
    boardTasks,
    fleetStatus,
    fleetChat,
    cryoHistory,
  };
}

/**
 * Heartbeat — agent is alive. Updates registry + cryo.
 */
export function heartbeat(input: { agentName: string; vmId: string }): { ok: true; timestamp: string } {
  const { agentName, vmId } = input;

  // Update registry
  try {
    registryStore.heartbeat(vmId);
  } catch {
    // VM might not be registered — try to register
    try {
      registryStore.register({
        id: vmId,
        name: agentName,
        role: "worker",
        address: vmId,
        registeredBy: agentName,
      });
    } catch {
      // ignore
    }
  }

  // Update cryo status
  try {
    cryoStore.updateAgent(agentName, { currentVmId: vmId, status: "awake" });
  } catch {
    // ignore if agent not in cryo
  }

  return { ok: true, timestamp: new Date().toISOString() };
}

/**
 * Debrief — agent calls this before shutdown.
 * Records what happened, hibernates the agent.
 */
export function debrief(input: DebriefInput): { ok: true; hibernated: boolean } {
  const { agentName, summary, artifacts, commitId } = input;

  if (!agentName || !summary) {
    throw new Error("agentName and summary are required");
  }

  let hibernated = false;

  // Add notable event to cryo
  try {
    cryoStore.addEvent(agentName, {
      event: `debrief: ${summary}`,
      metadata: { artifacts: artifacts || [] },
    });

    // Hibernate the agent
    if (commitId) {
      cryoStore.hibernate(agentName, {
        commitId,
        summary,
        reason: "debrief",
      });
    } else {
      cryoStore.updateAgent(agentName, {
        status: "hibernating",
        currentVmId: null,
      });
    }
    hibernated = true;
  } catch {
    // Agent might not be in cryo — that's okay
  }

  // Post to feed
  try {
    feedStore.publish({
      agent: agentName,
      type: "agent_stopped",
      summary: `Debrief: ${summary}`,
      metadata: { artifacts: artifacts || [] },
    });
  } catch {
    // ignore
  }

  emit("boot", "boot.agent.debriefed", {
    agentName,
    summary,
    artifactCount: artifacts?.length || 0,
  }, agentName);

  return { ok: true, hibernated };
}

// ── Helpers ────────────────────────────────────────────────────────────

function pickPersona(taskHint?: string): Persona | null {
  const personas = personaStore.listPersonas();
  if (personas.length === 0) return null;

  if (taskHint) {
    const hint = taskHint.toLowerCase();
    // Try to match by specialization or tags
    const matched = personas.find((p) =>
      p.specializations?.some((s) => hint.includes(s.toLowerCase())) ||
      p.tags?.some((t) => hint.includes(t.toLowerCase()))
    );
    if (matched) return matched;
  }

  // Return first available
  return personas[0] || null;
}

function generateAgentName(persona: Persona | null): string {
  const prefix = persona?.name || "agent";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}`;
}

function getKBBriefing(): unknown[] {
  try {
    const entries = kbStore.listEntries({ active: true });
    // Return high-confidence entries (confidence >= 7)
    return entries
      .filter((e: any) => (e.confidence || 0) >= 7)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function getRecentFeed(hoursBack: number): unknown[] {
  try {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    return feedStore.list({ since, limit: 50 });
  } catch {
    return [];
  }
}

function getBoardTasks(agentName: string): unknown[] {
  try {
    const allTasks = boardStore.listTasks({ assignee: agentName });
    // Return open/in-progress tasks
    return allTasks.filter((t: any) => t.status !== "done" && t.status !== "cancelled");
  } catch {
    return [];
  }
}

function getFleetStatus(): { activeVMs: number; activeAgents: number; vms: unknown[] } {
  try {
    const vms = registryStore.list({}, false);
    const agents = cryoStore.listAgents({ status: "awake" });
    return {
      activeVMs: vms.length,
      activeAgents: agents.length,
      vms: vms.map((vm: any) => ({
        id: vm.id,
        name: vm.name,
        role: vm.role,
        status: vm.status,
      })),
    };
  } catch {
    return { activeVMs: 0, activeAgents: 0, vms: [] };
  }
}

function getRecentFleetChat(): unknown[] {
  try {
    // Get recent messages from the fleet-chat store
    const channels = fleetChatStore.listChannels();
    if (channels.length === 0) return [];
    const recentMessages: unknown[] = [];
    for (const ch of channels.slice(0, 3)) {
      try {
        const msgs = fleetChatStore.getMessages(ch.id, { limit: 10 });
        recentMessages.push(...msgs);
      } catch {
        // ignore
      }
    }
    return recentMessages.slice(0, 20);
  } catch {
    return [];
  }
}

function getCryoHistory(agentName: string): unknown[] {
  try {
    const agent = cryoStore.getAgent(agentName);
    return [
      {
        sessionsCompleted: agent.sessionsCompleted,
        tasksCompleted: agent.tasksCompleted,
        commitHistory: agent.commitHistory.slice(-5),
        notableEvents: agent.notableEvents.slice(-10),
      },
    ];
  } catch {
    return [];
  }
}
