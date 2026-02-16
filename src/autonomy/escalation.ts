/**
 * Escalation Engine — the human bridge.
 *
 * Decides when to notify Noah (via notifications + magic link).
 * Manages pending decisions that require human approval.
 *
 * NEVER auto-approve: infra deletion, key rotation, external fleet comms, budget increases.
 * Always notify on: agent spawn, agent failure, deploy trigger.
 */

import { AutonomyStore, NEVER_AUTO_APPROVE, type Escalation, type NeverAutoApproveAction } from "./store.js";
import { emit } from "../events/emit.js";

export interface EscalationDeps {
  store: AutonomyStore;
  selfBaseUrl?: string;
  authToken?: string;
}

export interface EscalationInput {
  type: Escalation["type"];
  title: string;
  detail: string;
  metadata?: Record<string, unknown>;
}

const BUDGET_WARNING_THRESHOLD = 0.8; // 80%

export class EscalationEngine {
  private deps: EscalationDeps;

  constructor(deps: EscalationDeps) {
    this.deps = deps;
  }

  /**
   * Raise an escalation — creates the record + sends notification.
   */
  async escalate(input: EscalationInput): Promise<Escalation> {
    const esc = this.deps.store.createEscalation(input);

    emit("autonomy", "escalation.created", {
      id: esc.id,
      type: esc.type,
      title: esc.title,
    }, "autonomy-loop");

    // Send notification
    await this.sendNotification(esc);

    return esc;
  }

  /**
   * Check if an action requires human approval (never auto-approve list).
   */
  requiresApproval(actionType: string): boolean {
    return (NEVER_AUTO_APPROVE as readonly string[]).includes(actionType);
  }

  /**
   * Approve a pending escalation.
   */
  approve(id: string, approvedBy = "human"): Escalation | null {
    const esc = this.deps.store.resolveEscalation(id, "approved", approvedBy);
    if (esc) {
      emit("autonomy", "escalation.approved", { id, approvedBy }, "autonomy-loop");
    }
    return esc;
  }

  /**
   * Reject a pending escalation.
   */
  reject(id: string, rejectedBy = "human"): Escalation | null {
    const esc = this.deps.store.resolveEscalation(id, "rejected", rejectedBy);
    if (esc) {
      emit("autonomy", "escalation.rejected", { id, rejectedBy }, "autonomy-loop");
    }
    return esc;
  }

  /**
   * Get all pending escalations.
   */
  getPending(): Escalation[] {
    return this.deps.store.getPendingEscalations();
  }

  /**
   * Check budget status and escalate if approaching limit.
   */
  async checkBudget(budgetStatus: {
    costTodayCents: number;
    tokensToday: number;
    blocked: boolean;
  }, budgetConfig: {
    maxCostPerDay: number;
    maxTokensPerDay: number;
  }): Promise<void> {
    const costRatio = budgetStatus.costTodayCents / budgetConfig.maxCostPerDay;
    const tokenRatio = budgetStatus.tokensToday / budgetConfig.maxTokensPerDay;

    if (budgetStatus.blocked) {
      await this.escalate({
        type: "budget_warning",
        title: "Budget limit EXCEEDED — all spending blocked",
        detail: `Cost: $${(budgetStatus.costTodayCents / 100).toFixed(2)} / $${(budgetConfig.maxCostPerDay / 100).toFixed(2)}. Tokens: ${budgetStatus.tokensToday} / ${budgetConfig.maxTokensPerDay}.`,
        metadata: { costRatio, tokenRatio, blocked: true },
      });
    } else if (costRatio >= BUDGET_WARNING_THRESHOLD || tokenRatio >= BUDGET_WARNING_THRESHOLD) {
      await this.escalate({
        type: "budget_warning",
        title: "Budget approaching limit (80%+)",
        detail: `Cost at ${(costRatio * 100).toFixed(0)}%, tokens at ${(tokenRatio * 100).toFixed(0)}%. Consider adjusting limits.`,
        metadata: { costRatio, tokenRatio, blocked: false },
      });
    }
  }

  /**
   * Escalate an agent failure (after retries exhausted).
   */
  async agentFailed(agentId: string, taskId: string, error: string, retries: number): Promise<Escalation> {
    return this.escalate({
      type: "agent_failure",
      title: `Agent ${agentId} failed after ${retries} retries`,
      detail: `Task: ${taskId}. Error: ${error}`,
      metadata: { agentId, taskId, error, retries },
    });
  }

  /**
   * Escalate a security event.
   */
  async securityEvent(event: string, detail: string, metadata?: Record<string, unknown>): Promise<Escalation> {
    return this.escalate({
      type: "security_event",
      title: `Security: ${event}`,
      detail,
      metadata,
    });
  }

  /**
   * Escalate sprint plan for approval.
   */
  async sprintReady(sprintId: string, taskCount: number, summary: string): Promise<Escalation> {
    return this.escalate({
      type: "sprint_approval",
      title: `Sprint plan ready for approval (${taskCount} tasks)`,
      detail: summary,
      metadata: { sprintId, taskCount },
    });
  }

  /**
   * Escalate incoming fleet message.
   */
  async fleetMessage(fromFleet: string, message: string): Promise<Escalation> {
    return this.escalate({
      type: "fleet_message",
      title: `Message from ${fromFleet}'s fleet`,
      detail: message,
      metadata: { fromFleet },
    });
  }

  // ── Notification delivery ──────────────────────────────────────────────────

  private async sendNotification(esc: Escalation): Promise<void> {
    const baseUrl = this.deps.selfBaseUrl || "http://localhost:3000";
    const token = this.deps.authToken || process.env.VERS_AUTH_TOKEN || "";

    const priorityMap: Record<Escalation["type"], string> = {
      budget_warning: "high",
      agent_failure: "high",
      security_event: "critical",
      sprint_approval: "normal",
      fleet_message: "normal",
      blocker: "high",
    };

    try {
      await fetch(`${baseUrl}/notifications`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: "attention",
          title: esc.title,
          body: esc.detail,
          priority: priorityMap[esc.type] || "normal",
          source: "autonomy-loop",
          url: `#autonomy/escalation/${esc.id}`,
        }),
      });
    } catch (err) {
      console.error("[autonomy] notification POST failed:", err);
    }
  }
}
