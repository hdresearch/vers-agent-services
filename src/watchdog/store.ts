import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus = "active" | "stale" | "zombie" | "dead";

export interface AgentHealth {
  agentId: string;
  vmId: string;
  lastEventHash: string;
  lastEventTime: string;
  lastCheckTime: string;
  status: AgentStatus;
  staleSince?: string;
  alertsSent: number;
}

export interface WatchdogState {
  running: boolean;
  checkIntervalMs: number;
  agents: Record<string, AgentHealth>;
  startedAt?: string;
}

// ── Thresholds (ms) ──────────────────────────────────────────────────────────

export const THRESHOLDS = {
  STALE_MS: 2 * 60 * 1000,       // 2 min — no new events → stale
  ZOMBIE_WARN_MS: 10 * 60 * 1000, // 10 min — first alert (zombie_detected)
  ZOMBIE_NOTE_MS: 15 * 60 * 1000, // 15 min — board note
  ZOMBIE_CONFIRM_MS: 20 * 60 * 1000, // 20 min — confirmed zombie
  CHECK_INTERVAL_MS: 2 * 60 * 1000,  // check every 2 min
} as const;

// ── Dependency interfaces (so we don't import stores directly) ───────────────

export interface FeedAdapter {
  getLatestEvent(agent: string): { id: string; timestamp: string } | null;
  publishEvent(agent: string, type: string, summary: string, detail?: string): void;
}

export interface RegistryAdapter {
  getRunningAgents(): Array<{ id: string; name: string }>;
}

export interface BoardAdapter {
  findTaskByAgent(agent: string): string | null; // returns taskId or null
  addNote(taskId: string, author: string, content: string): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function hashEvent(id: string, timestamp: string): string {
  return createHash("sha256").update(`${id}:${timestamp}`).digest("hex").slice(0, 16);
}

export function classifyAgent(
  lastEventTime: string | null,
  now: Date = new Date(),
): AgentStatus {
  if (!lastEventTime) return "dead";
  const elapsed = now.getTime() - new Date(lastEventTime).getTime();
  if (elapsed <= THRESHOLDS.STALE_MS) return "active";
  if (elapsed < THRESHOLDS.ZOMBIE_WARN_MS) return "stale";
  return "zombie";
}

export function staleDurationMs(health: AgentHealth, now: Date = new Date()): number {
  if (!health.staleSince) return 0;
  return now.getTime() - new Date(health.staleSince).getTime();
}

// ── Watchdog Store ──────────────────────────────────────────────────────────

export class WatchdogStore {
  private agents: Map<string, AgentHealth> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _startedAt?: string;

  private feed: FeedAdapter;
  private registry: RegistryAdapter;
  private board: BoardAdapter;

  constructor(feed: FeedAdapter, registry: RegistryAdapter, board: BoardAdapter) {
    this.feed = feed;
    this.registry = registry;
    this.board = board;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(intervalMs = THRESHOLDS.CHECK_INTERVAL_MS): void {
    if (this._running) return;
    this._running = true;
    this._startedAt = new Date().toISOString();
    this.timer = setInterval(() => this.check(), intervalMs);
    // Run first check immediately
    this.check();
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this._running;
  }

  // ── Core check loop ──────────────────────────────────────────────────────

  check(now = new Date()): void {
    const runningAgents = this.registry.getRunningAgents();

    // Mark agents no longer in registry as dead
    const registeredIds = new Set(runningAgents.map((a) => a.id));
    for (const [id, health] of this.agents) {
      if (!registeredIds.has(id) && health.status !== "dead") {
        health.status = "dead";
        health.lastCheckTime = now.toISOString();
      }
    }

    for (const agent of runningAgents) {
      const latest = this.feed.getLatestEvent(agent.name);
      const existing = this.agents.get(agent.id);
      const nowIso = now.toISOString();

      const newHash = latest ? hashEvent(latest.id, latest.timestamp) : "";
      const newStatus = classifyAgent(latest?.timestamp ?? null, now);

      let health: AgentHealth;

      if (!existing) {
        // First time seeing this agent
        health = {
          agentId: agent.name,
          vmId: agent.id,
          lastEventHash: newHash,
          lastEventTime: latest?.timestamp ?? "",
          lastCheckTime: nowIso,
          status: newStatus,
          staleSince: newStatus !== "active" ? (latest?.timestamp ?? nowIso) : undefined,
          alertsSent: 0,
        };
        this.agents.set(agent.id, health);
      } else {
        health = existing;
        health.lastCheckTime = nowIso;

        // If the hash changed, agent is alive
        if (newHash && newHash !== health.lastEventHash) {
          health.lastEventHash = newHash;
          health.lastEventTime = latest!.timestamp;
          health.status = "active";
          health.staleSince = undefined;
          health.alertsSent = 0;
          continue;
        }

        // No new output — classify
        health.status = newStatus;

        // Track when staleness began
        if (newStatus !== "active" && !health.staleSince) {
          health.staleSince = health.lastEventTime || nowIso;
        }
        if (newStatus === "active") {
          health.staleSince = undefined;
          health.alertsSent = 0;
          continue;
        }
      }

      // Skip escalation for active/dead agents
      if (health.status === "active" || health.status === "dead") continue;

      // ── Escalation ─────────────────────────────────────────────────────
      const staleMs = staleDurationMs(health, now);

      // Alert 1: 10 min — zombie_detected feed event
      if (staleMs >= THRESHOLDS.ZOMBIE_WARN_MS && health.alertsSent < 1) {
        this.feed.publishEvent(
          "watchdog",
          "custom",
          `zombie_detected: ${health.agentId} — no output for ${Math.round(staleMs / 60000)}min`,
          JSON.stringify({
            event: "zombie_detected",
            agent: health.agentId,
            vmId: health.vmId,
            lastActivity: health.lastEventTime,
            staleSinceMs: staleMs,
          }),
        );
        health.alertsSent = 1;
      }

      // Alert 2: 15 min — board note on agent's task
      if (staleMs >= THRESHOLDS.ZOMBIE_NOTE_MS && health.alertsSent < 2) {
        const taskId = this.board.findTaskByAgent(health.agentId);
        if (taskId) {
          this.board.addNote(
            taskId,
            "watchdog",
            `⚠️ Agent appears stuck — no output for ${Math.round(staleMs / 60000)}min. Agent: ${health.agentId}, VM: ${health.vmId}`,
          );
        }
        health.alertsSent = 2;
      }

      // Alert 3: 20 min — zombie_confirmed
      if (staleMs >= THRESHOLDS.ZOMBIE_CONFIRM_MS && health.alertsSent < 3) {
        health.status = "zombie";
        this.feed.publishEvent(
          "watchdog",
          "custom",
          `zombie_confirmed: ${health.agentId} — no output for ${Math.round(staleMs / 60000)}min`,
          JSON.stringify({
            event: "zombie_confirmed",
            agent: health.agentId,
            vmId: health.vmId,
            lastActivity: health.lastEventTime,
            staleSinceMs: staleMs,
          }),
        );
        health.alertsSent = 3;
      }
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getAll(): AgentHealth[] {
    return Array.from(this.agents.values());
  }

  getZombies(): AgentHealth[] {
    return this.getAll().filter((a) => a.status === "zombie");
  }

  getAgent(vmId: string): AgentHealth | undefined {
    return this.agents.get(vmId);
  }

  getState(): WatchdogState {
    return {
      running: this._running,
      checkIntervalMs: THRESHOLDS.CHECK_INTERVAL_MS,
      agents: Object.fromEntries(this.agents),
      startedAt: this._startedAt,
    };
  }

  /** Reset internal state (for testing) */
  reset(): void {
    this.stop();
    this.agents.clear();
    this._startedAt = undefined;
  }
}
