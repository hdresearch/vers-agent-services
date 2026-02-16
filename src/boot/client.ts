/**
 * Boot client — call from an agent to register, get briefed, and debrief.
 *
 * Usage:
 *   import { bootAgent, debriefAgent, sendHeartbeat } from './boot/client';
 *   const identity = await bootAgent({ infra: 'http://...', auth: 'Bearer ...', vmId: '...' });
 */

export interface BootClientOptions {
  /** Infra URL (e.g. http://abc123.vm.vers.sh:3000) */
  infra: string;
  /** Bearer token */
  auth: string;
  /** This VM's ID */
  vmId: string;
  /** Optional agent name (to restore identity from cryo) */
  name?: string;
  /** Optional task hint for persona matching */
  taskHint?: string;
}

export interface BootIdentity {
  identity: {
    name: string;
    displayName: string;
    persona: string;
    status: string;
    currentVmId: string | null;
    [key: string]: unknown;
  };
  persona: {
    name: string;
    displayName: string;
    systemPrompt: string;
    traits: string[];
    specializations: string[];
    [key: string]: unknown;
  } | null;
  kbBriefing: unknown[];
  recentLog: unknown[];
  boardTasks: unknown[];
  fleetStatus: {
    activeVMs: number;
    activeAgents: number;
    vms: unknown[];
  };
}

export interface DebriefOptions {
  infra: string;
  auth: string;
  agentName: string;
  summary: string;
  artifacts?: Array<{ type: string; uri: string; label?: string }>;
  commitId?: string;
}

export interface HeartbeatOptions {
  infra: string;
  auth: string;
  agentName: string;
  vmId: string;
}

async function request(url: string, auth: string, method: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    "Authorization": auth,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = (data as any)?.error || `HTTP ${res.status}`;
    throw new Error(`Boot protocol error: ${msg}`);
  }

  return data;
}

/**
 * Register this agent with the boot protocol.
 * Returns full identity + briefing data.
 */
export async function bootAgent(opts: BootClientOptions): Promise<BootIdentity> {
  const result = await request(
    `${opts.infra}/boot/register`,
    opts.auth,
    "POST",
    {
      vmId: opts.vmId,
      name: opts.name,
      taskHint: opts.taskHint,
    },
  );
  return result as BootIdentity;
}

/**
 * Get a full briefing for a named agent.
 */
export async function getAgentBriefing(opts: { infra: string; auth: string; agentName: string }): Promise<unknown> {
  return request(
    `${opts.infra}/boot/briefing/${encodeURIComponent(opts.agentName)}`,
    opts.auth,
    "GET",
  );
}

/**
 * Send a heartbeat — call periodically to stay alive.
 */
export async function sendHeartbeat(opts: HeartbeatOptions): Promise<{ ok: true; timestamp: string }> {
  const result = await request(
    `${opts.infra}/boot/heartbeat`,
    opts.auth,
    "POST",
    {
      agentName: opts.agentName,
      vmId: opts.vmId,
    },
  );
  return result as { ok: true; timestamp: string };
}

/**
 * Debrief before shutdown — records summary, hibernates agent.
 */
export async function debriefAgent(opts: DebriefOptions): Promise<{ ok: true; hibernated: boolean }> {
  const result = await request(
    `${opts.infra}/boot/debrief`,
    opts.auth,
    "POST",
    {
      agentName: opts.agentName,
      summary: opts.summary,
      artifacts: opts.artifacts,
      commitId: opts.commitId,
    },
  );
  return result as { ok: true; hibernated: boolean };
}

/**
 * Start a heartbeat loop that runs every `intervalMs` (default: 30s).
 * Returns a stop function.
 */
export function startHeartbeatLoop(
  opts: HeartbeatOptions,
  intervalMs = 30_000,
): () => void {
  const timer = setInterval(() => {
    sendHeartbeat(opts).catch((err) => {
      console.error("[boot] heartbeat failed:", err.message);
    });
  }, intervalMs);

  // Send first heartbeat immediately
  sendHeartbeat(opts).catch((err) => {
    console.error("[boot] initial heartbeat failed:", err.message);
  });

  return () => clearInterval(timer);
}
