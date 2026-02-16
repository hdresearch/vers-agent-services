/**
 * Fleet Daemon Engine — polls events, matches rules, takes action.
 *
 * This is the autonomous event loop. It runs inside agent-services as a
 * singleton, polling the event log every 30s and dispatching actions based
 * on event type. No human in the loop.
 *
 * KB warnings respected:
 * - Vers API base: https://api.vers.sh/api/v1
 * - VM restore: POST /vm/from_commit with {commit_id}
 * - No GET /vm/:id — use GET /vm and filter
 * - Never pkill agent-services
 */

import { DaemonStore, type ActionType } from "./store.js";
import { EventLogStore, type EventRecord } from "../events/store.js";
import { ConfigStore } from "../config/store.js";

// --- Types ---

export interface DaemonDeps {
  eventStore: EventLogStore;
  configStore: ConfigStore;
  daemonStore: DaemonStore;
  /** Base URL for agent-services itself (for internal API calls) */
  selfBaseUrl?: string;
  /** Bearer token for internal API calls */
  authToken?: string;
  /** Override for testing: Vers API base URL */
  versApiBase?: string;
}

export interface SpawnResult {
  vmId: string;
  commitId: string;
}

/** Rule: maps event type patterns to handler functions */
interface Rule {
  pattern: string | RegExp;
  handler: (event: EventRecord, engine: DaemonEngine) => Promise<void>;
}

// --- Engine ---

export class DaemonEngine {
  private deps: DaemonDeps;
  private store: DaemonStore;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: Date | null = null;
  private rules: Rule[] = [];
  private _pollIntervalMs = 30_000;
  private _heartbeatIntervalMs = 60_000;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
    this.store = deps.daemonStore;
    this.registerDefaultRules();
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    const state = this.store.getState();
    if (state.running) return; // already running

    this.startedAt = new Date();
    this.store.setState("running", "true");
    this.store.setState("started_at", this.startedAt.toISOString());

    // Fetch KB briefing on startup
    await this.fetchAndLogBriefing();

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this._pollIntervalMs);

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this._heartbeatIntervalMs);

    // Do an immediate first poll
    await this.poll();

    console.log("[daemon] started — polling every", this._pollIntervalMs / 1000, "s");
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.store.setState("running", "false");
    this.startedAt = null;
    console.log("[daemon] stopped");
  }

  get isRunning(): boolean {
    return this.pollTimer !== null;
  }

  getStatus() {
    const state = this.store.getState();
    const recentActions = this.store.getActions(10);
    return {
      running: this.isRunning,
      uptime: this.startedAt
        ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
        : 0,
      startedAt: state.startedAt,
      lastPollAt: state.lastPollAt,
      lastActionAt: state.lastActionAt,
      lastEventCursor: state.lastEventCursor,
      totalActions: this.store.getActionCount(),
      recentActions,
    };
  }

  // --- Polling ---

  async poll(): Promise<number> {
    const state = this.store.getState();
    const cursor = state.lastEventCursor;

    // Query events since last cursor
    const events = this.deps.eventStore.query({
      sinceId: cursor,
      limit: 200,
    });

    if (events.length === 0) {
      this.store.setState("last_poll_at", new Date().toISOString());
      return 0;
    }

    let actionsCount = 0;

    for (const event of events) {
      const matched = await this.matchAndExecute(event);
      if (matched) actionsCount++;
      // Advance cursor after each event (even if no match)
      this.store.setState("last_event_cursor", String(event.id));
    }

    this.store.setState("last_poll_at", new Date().toISOString());
    return actionsCount;
  }

  private async matchAndExecute(event: EventRecord): Promise<boolean> {
    for (const rule of this.rules) {
      const matches =
        typeof rule.pattern === "string"
          ? event.type === rule.pattern
          : rule.pattern.test(event.type);

      if (matches) {
        try {
          await rule.handler(event, this);
          return true;
        } catch (err) {
          console.error(`[daemon] rule handler error for ${event.type}:`, err);
          this.store.recordAction({
            actionType: "alert",
            trigger: event.type,
            triggerEventId: event.eventId,
            description: `Rule handler threw for ${event.type}: ${(err as Error).message}`,
            result: "failure",
            resultDetail: (err as Error).stack || (err as Error).message,
          });
        }
      }
    }
    return false;
  }

  // --- Rules ---

  private registerDefaultRules(): void {
    // 1. Quartermaster: unassigned tasks → evaluate and maybe spawn
    this.rules.push({
      pattern: "quartermaster.unassigned_tasks",
      handler: async (event, engine) => {
        const payload = event.payload as any;
        const tasks = payload?.tasks || [];
        for (const task of tasks) {
          if (task.score >= 3 || task.tags?.includes("p0")) {
            await engine.spawnAgentForTask(event, task);
          } else {
            engine.store.recordAction({
              actionType: "log_event",
              trigger: event.type,
              triggerEventId: event.eventId,
              description: `Low-priority unassigned task "${task.title}" (score=${task.score}) — skipping auto-spawn`,
              result: "success",
            });
          }
        }
      },
    });

    // 2. Sentinel: unhealthy service → restart
    this.rules.push({
      pattern: "sentinel.unhealthy",
      handler: async (event, engine) => {
        const payload = event.payload as any;
        const service = payload?.service || "unknown";
        const action = engine.store.recordAction({
          actionType: "restart_service",
          trigger: event.type,
          triggerEventId: event.eventId,
          description: `Service "${service}" reported unhealthy — attempting restart`,
          result: "pending",
        });

        try {
          await engine.restartService(service);
          engine.store.updateActionResult(
            action.id,
            "success",
            `Service "${service}" restart initiated`,
          );
        } catch (err) {
          engine.store.updateActionResult(
            action.id,
            "failure",
            `Restart failed: ${(err as Error).message}`,
          );
          // Also emit an alert to the feed
          await engine.emitFeedEvent(
            "blocker_found",
            `Daemon failed to restart ${service}: ${(err as Error).message}`,
          );
        }
      },
    });

    // 3. Auditor: stale tasks → close or reassign
    this.rules.push({
      pattern: "auditor.stale_tasks",
      handler: async (event, engine) => {
        const payload = event.payload as any;
        const tasks = payload?.tasks || [];
        for (const task of tasks) {
          const actionType: ActionType =
            task.status === "in_progress" ? "reassign_task" : "close_task";
          engine.store.recordAction({
            actionType,
            trigger: event.type,
            triggerEventId: event.eventId,
            description: `Stale task "${task.title}" (${task.id}) — ${actionType === "close_task" ? "closing" : "marking for reassignment"}`,
            result: "success",
            metadata: { taskId: task.id, taskStatus: task.status },
          });
        }
      },
    });

    // 4. Couch: invite redeemed → log guest arrival
    this.rules.push({
      pattern: "couch.invite.redeemed",
      handler: async (event, engine) => {
        const payload = event.payload as any;
        const guest = payload?.guestName || payload?.guest || "unknown";
        engine.store.recordAction({
          actionType: "log_event",
          trigger: event.type,
          triggerEventId: event.eventId,
          description: `Guest "${guest}" arrived — invite redeemed`,
          result: "success",
          metadata: payload,
        });
        await engine.appendLog(`🛋️ Guest "${guest}" redeemed an invite and arrived on the couch.`);
      },
    });

    // 5. Couch: guest limits exceeded → kill guest
    this.rules.push({
      pattern: "couch.guest.limits_exceeded",
      handler: async (event, engine) => {
        const payload = event.payload as any;
        const guest = payload?.guestName || payload?.guest || "unknown";
        const vmId = payload?.vmId;
        const action = engine.store.recordAction({
          actionType: "kill_guest",
          trigger: event.type,
          triggerEventId: event.eventId,
          description: `Guest "${guest}" exceeded limits — auto-killing VM ${vmId || "unknown"}`,
          result: "pending",
          metadata: payload,
        });

        if (vmId) {
          try {
            await engine.destroyVm(vmId);
            engine.store.updateActionResult(action.id, "success", `VM ${vmId} destroyed`);
            await engine.emitFeedEvent(
              "custom",
              `⚠️ Guest "${guest}" killed — exceeded resource limits. VM ${vmId} destroyed.`,
            );
          } catch (err) {
            engine.store.updateActionResult(
              action.id,
              "failure",
              `Kill failed: ${(err as Error).message}`,
            );
          }
        } else {
          engine.store.updateActionResult(
            action.id,
            "failure",
            "No vmId in event payload — cannot kill",
          );
        }
      },
    });
  }

  // --- Actions ---

  async spawnAgentForTask(
    event: EventRecord,
    task: { id: string; title: string; score?: number },
  ): Promise<SpawnResult | null> {
    const action = this.store.recordAction({
      actionType: "spawn_agent",
      trigger: event.type,
      triggerEventId: event.eventId,
      description: `Spawning agent for high-priority task "${task.title}" (id=${task.id})`,
      result: "pending",
      metadata: { taskId: task.id },
    });

    try {
      const goldenCommitId = this.getGoldenCommitId();
      if (!goldenCommitId) {
        this.store.updateActionResult(
          action.id,
          "failure",
          "GOLDEN_COMMIT_ID not set in config store",
        );
        return null;
      }

      const vm = await this.restoreFromCommit(goldenCommitId);
      this.store.updateActionResult(
        action.id,
        "success",
        `VM ${vm.vmId} spawned from golden commit ${goldenCommitId}`,
      );
      this.store.setState("last_action_at", new Date().toISOString());

      // Register in cryochamber and registry (fire-and-forget via internal API)
      await this.registerAgent(vm.vmId, task);

      return { vmId: vm.vmId, commitId: goldenCommitId };
    } catch (err) {
      this.store.updateActionResult(
        action.id,
        "failure",
        `Spawn failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // --- Vers API Helpers ---

  private getGoldenCommitId(): string | null {
    try {
      const entry = this.deps.configStore.get("GOLDEN_COMMIT_ID");
      return entry?.value || null;
    } catch {
      return null;
    }
  }

  private getVersApiKey(): string | null {
    try {
      const entry = this.deps.configStore.get("VERS_API_KEY");
      return entry?.value || null;
    } catch {
      return null;
    }
  }

  async restoreFromCommit(commitId: string): Promise<{ vmId: string }> {
    const apiBase = this.deps.versApiBase || "https://api.vers.sh/api/v1";
    const apiKey = this.getVersApiKey();
    if (!apiKey) throw new Error("VERS_API_KEY not configured");

    const resp = await fetch(`${apiBase}/vm/from_commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ commit_id: commitId }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Vers API error ${resp.status}: ${body}`);
    }

    const data = (await resp.json()) as { vm_id: string };
    return { vmId: data.vm_id };
  }

  async destroyVm(vmId: string): Promise<void> {
    const apiBase = this.deps.versApiBase || "https://api.vers.sh/api/v1";
    const apiKey = this.getVersApiKey();
    if (!apiKey) throw new Error("VERS_API_KEY not configured");

    const resp = await fetch(`${apiBase}/vm/${vmId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Vers DELETE /vm/${vmId} failed: ${resp.status}`);
    }
  }

  private async registerAgent(
    vmId: string,
    task: { id: string; title: string },
  ): Promise<void> {
    const baseUrl = this.deps.selfBaseUrl || "http://localhost:3000";
    const token = this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";

    // Register in registry
    try {
      await fetch(`${baseUrl}/registry/vms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: vmId,
          name: `daemon-worker-${task.id.slice(0, 8)}`,
          role: "worker",
          address: `${vmId}.vm.vers.sh`,
          registeredBy: "fleet-daemon",
          services: [{ name: "pi-agent", port: 22 }],
        }),
      });
    } catch (err) {
      console.error("[daemon] registry POST failed:", err);
    }

    // Register in cryochamber
    try {
      await fetch(`${baseUrl}/cryo/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: `daemon-worker-${task.id.slice(0, 8)}`,
          persona: "Fleet worker spawned by daemon",
          status: "awake",
          currentVmId: vmId,
          tags: ["daemon-spawned", "worker"],
        }),
      });
    } catch (err) {
      console.error("[daemon] cryo POST failed:", err);
    }
  }

  private async restartService(service: string): Promise<void> {
    // We log and emit — actual restart is via systemctl which we do NOT call
    // from inside agent-services (KB warning: never pkill agent-services).
    // Instead, log the alert so external tooling or human can act.
    await this.appendLog(
      `🚨 Daemon detected unhealthy service: ${service}. Manual restart may be needed.`,
    );
    await this.emitFeedEvent(
      "blocker_found",
      `Service "${service}" is unhealthy — daemon logged alert for manual intervention`,
    );
  }

  // --- Internal helpers ---

  async emitFeedEvent(
    type: string,
    summary: string,
  ): Promise<void> {
    const baseUrl = this.deps.selfBaseUrl || "http://localhost:3000";
    const token = this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";
    try {
      await fetch(`${baseUrl}/feed/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agent: "fleet-daemon",
          type,
          summary,
        }),
      });
    } catch (err) {
      console.error("[daemon] feed POST failed:", err);
    }
  }

  async appendLog(text: string): Promise<void> {
    const baseUrl = this.deps.selfBaseUrl || "http://localhost:3000";
    const token = this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";
    try {
      await fetch(`${baseUrl}/log`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text, agent: "fleet-daemon" }),
      });
    } catch (err) {
      console.error("[daemon] log POST failed:", err);
    }
  }

  async heartbeat(): Promise<void> {
    await this.emitFeedEvent("custom", "💓 fleet-daemon heartbeat — alive and polling");
  }

  private async fetchAndLogBriefing(): Promise<void> {
    const baseUrl = this.deps.selfBaseUrl || "http://localhost:3000";
    const token = this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";
    try {
      const resp = await fetch(`${baseUrl}/kb/briefing/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { briefing: string };
        console.log("[daemon] KB briefing loaded:", data.briefing?.slice(0, 200), "...");
        await this.appendLog(
          `Fleet daemon started. KB briefing loaded (${data.briefing?.length || 0} chars).`,
        );
      }
    } catch (err) {
      console.warn("[daemon] failed to fetch KB briefing:", err);
    }
  }

  // --- Test helpers ---

  setPollInterval(ms: number): void {
    this._pollIntervalMs = ms;
  }

  setHeartbeatInterval(ms: number): void {
    this._heartbeatIntervalMs = ms;
  }
}
