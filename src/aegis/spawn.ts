/**
 * Spawn Limits — control VM creation with concurrency limits,
 * hourly caps, and a circuit breaker for consecutive failures.
 */

import type { AegisStore, SpawnConfig, SpawnStatus } from "./store.js";

export interface SpawnCheckResult {
  allowed: boolean;
  reason?: string;
  status: SpawnStatus;
}

export class SpawnLimiter {
  constructor(private store: AegisStore) {}

  /**
   * Pre-flight check: can we spawn a new VM?
   */
  canSpawn(): SpawnCheckResult {
    const check = this.store.canSpawn();
    const status = this.store.getSpawnStatus();
    return { allowed: check.allowed, reason: check.reason, status };
  }

  /**
   * Record a successful spawn.
   */
  recordSpawn(vmId: string, agentId: string): SpawnCheckResult {
    this.store.recordSpawn(vmId, agentId, "spawn");
    const status = this.store.getSpawnStatus();
    return { allowed: true, status };
  }

  /**
   * Record a VM destruction.
   */
  recordDestroy(vmId: string, agentId: string): void {
    this.store.recordSpawn(vmId, agentId, "destroy");
  }

  /**
   * Record a spawn failure (feeds the circuit breaker).
   */
  recordFailure(vmId: string, agentId: string): SpawnCheckResult {
    this.store.recordSpawn(vmId, agentId, "failure");
    const status = this.store.getSpawnStatus();

    if (status.circuitBreakerOpen) {
      this.store.audit("spawn", "circuit_breaker_tripped",
        `${status.consecutiveFailures} consecutive failures — spawning halted`);
    }

    return { allowed: !status.circuitBreakerOpen, status };
  }

  /**
   * Reset the circuit breaker (manual intervention).
   */
  resetCircuitBreaker(): SpawnStatus {
    this.store.resetCircuitBreaker();
    // Record a synthetic non-failure to break the chain
    this.store.recordSpawn("__reset__", "aegis", "destroy");
    return this.store.getSpawnStatus();
  }

  /**
   * Get current status.
   */
  getStatus(): SpawnStatus {
    return this.store.getSpawnStatus();
  }

  /**
   * Get config.
   */
  getConfig(): SpawnConfig {
    return this.store.getSpawnConfig();
  }

  /**
   * Update config.
   */
  setConfig(config: Partial<SpawnConfig>): SpawnConfig {
    return this.store.setSpawnConfig(config);
  }
}
