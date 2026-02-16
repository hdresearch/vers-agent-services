/**
 * Budget Breaker — track token spend per agent, per hour, per day.
 * When limits are hit: block further LLM calls, notify, log.
 */

import type { AegisStore, BudgetConfig, BudgetStatus } from "./store.js";
import { createDeepLinkedNotification } from "../notifications/deeplink.js";

export interface BudgetCheckResult {
  allowed: boolean;
  status: BudgetStatus;
}

export class BudgetBreaker {
  constructor(private store: AegisStore) {}

  /**
   * Record token usage for an agent. Returns whether the agent is still within budget.
   */
  record(agentId: string, tokens: number, costCents: number): BudgetCheckResult {
    this.store.recordTokenUsage(agentId, tokens, costCents);
    const status = this.store.getBudgetStatus(agentId);

    if (status.blocked) {
      this.store.audit("budget", "agent_blocked", `${agentId}: ${status.reason}`);
      try {
        createDeepLinkedNotification({
          type: "alert",
          title: `🛡️ Aegis: Agent ${agentId} blocked`,
          body: status.reason || "Budget limit exceeded",
          priority: "critical",
          source: "aegis",
          uiPath: "/ui/v2",
        });
      } catch {}
    }

    return { allowed: !status.blocked, status };
  }

  /**
   * Check if an agent can make an LLM call (pre-flight check).
   */
  check(agentId?: string): BudgetCheckResult {
    const status = this.store.getBudgetStatus(agentId);
    return { allowed: !status.blocked, status };
  }

  /**
   * Get global budget status (all agents combined).
   */
  globalStatus(): BudgetStatus {
    return this.store.getBudgetStatus();
  }

  /**
   * Get budget status for a specific agent.
   */
  agentStatus(agentId: string): BudgetStatus {
    return this.store.getBudgetStatus(agentId);
  }

  /**
   * Get current config.
   */
  getConfig(): BudgetConfig {
    return this.store.getBudgetConfig();
  }

  /**
   * Update config.
   */
  setConfig(config: Partial<BudgetConfig>): BudgetConfig {
    return this.store.setBudgetConfig(config);
  }
}
