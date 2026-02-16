/**
 * Sub-fleet Orchestrator — spawns VMs, manages teardown, enforces TTL.
 *
 * Isolation rules:
 * - Sub-fleet VMs do NOT get the main infra auth token
 * - They get a scoped token for peer-to-peer comms only
 * - Sub-fleet VMs cannot delete main fleet VMs (protected list checked)
 */

import type { SubFleetStore, SubFleet } from "./store.js";
import type { VersClient } from "./vers-client.js";

export interface OrchestratorDeps {
  store: SubFleetStore;
  versClient: VersClient;
  /** Check if a VM is on the protected list (Aegis) */
  isProtected?: (vmId: string) => boolean;
  /** Interval in ms for TTL reaper — default 60s */
  reaperIntervalMs?: number;
}

export interface CreateResult {
  subfleetId: string;
  vms: Array<{ vmId: string; name: string; address: string; status: string }>;
  expiresAt: string;
  scopedToken: string;
}

export class SubFleetOrchestrator {
  private deps: OrchestratorDeps;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(opts: {
    name: string;
    purpose: string;
    goldenCommit: string;
    vmCount: number;
    ttlHours: number;
  }): Promise<CreateResult> {
    const fleet = this.deps.store.create(opts);

    const vmResults: CreateResult["vms"] = [];

    // Spawn VMs in parallel
    const spawnPromises = Array.from({ length: opts.vmCount }, (_, i) => {
      const vmName = `${opts.name}-${i}`;
      return this.spawnVM(fleet, vmName, i);
    });

    const results = await Promise.allSettled(spawnPromises);

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        vmResults.push(result.value);
      }
    }

    // If zero VMs spawned, mark fleet as failed
    if (vmResults.length === 0) {
      this.deps.store.setStatus(fleet.id, "destroyed");
      throw new Error(`Failed to spawn any VMs for sub-fleet "${opts.name}"`);
    }

    return {
      subfleetId: fleet.id,
      vms: vmResults,
      expiresAt: fleet.expiresAt,
      scopedToken: fleet.scopedToken,
    };
  }

  private async spawnVM(
    fleet: SubFleet,
    name: string,
    index: number,
  ): Promise<CreateResult["vms"][0] | null> {
    try {
      const { vmId } = await this.deps.versClient.spawnFromCommit(fleet.goldenCommit);
      const vm = this.deps.store.addVM(fleet.id, vmId, name);
      this.deps.store.setVMStatus(vmId, "running");
      return {
        vmId: vm.vmId,
        name: vm.name,
        address: vm.address,
        status: "running",
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.deps.store.audit(fleet.id, "vm_spawn_failed", `${name}: ${errorMsg}`);
      return null;
    }
  }

  // ── Destroy ────────────────────────────────────────────────────────────────

  async destroy(subfleetId: string): Promise<{ destroyed: number; errors: string[] }> {
    const detail = this.deps.store.getDetail(subfleetId);
    if (!detail) throw new Error(`Sub-fleet ${subfleetId} not found`);

    this.deps.store.setStatus(subfleetId, "destroying");

    const errors: string[] = [];
    let destroyed = 0;

    for (const vm of detail.vms) {
      if (vm.status === "destroyed") continue;

      // Safety check: never destroy protected VMs
      if (this.deps.isProtected?.(vm.vmId)) {
        errors.push(`${vm.vmId} is protected — skipped`);
        this.deps.store.audit(subfleetId, "destroy_blocked", `${vm.vmId} is on protected list`);
        continue;
      }

      try {
        await this.deps.versClient.destroyVM(vm.vmId);
        this.deps.store.setVMStatus(vm.vmId, "destroyed");
        destroyed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${vm.vmId}: ${msg}`);
        this.deps.store.audit(subfleetId, "destroy_failed", `${vm.vmId}: ${msg}`);
      }
    }

    this.deps.store.setStatus(subfleetId, "destroyed");
    this.deps.store.audit(subfleetId, "fleet_destroyed", `${destroyed} VMs destroyed, ${errors.length} errors`);

    return { destroyed, errors };
  }

  // ── TTL Reaper ─────────────────────────────────────────────────────────────

  startReaper(): void {
    if (this.reaperTimer) return;
    const intervalMs = this.deps.reaperIntervalMs ?? 60_000;
    this.reaperTimer = setInterval(() => this.reap(), intervalMs);
    console.log(`[subfleet] TTL reaper started — checking every ${intervalMs / 1000}s`);
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  async reap(): Promise<string[]> {
    const expired = this.deps.store.getExpiredFleets();
    const reaped: string[] = [];

    for (const fleet of expired) {
      try {
        console.log(`[subfleet] Reaping expired sub-fleet "${fleet.name}" (${fleet.id})`);
        await this.destroy(fleet.id);
        reaped.push(fleet.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[subfleet] Reap failed for ${fleet.id}: ${msg}`);
      }
    }

    return reaped;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(subfleetId: string) {
    const detail = this.deps.store.getDetail(subfleetId);
    if (!detail) return null;

    const now = Date.now();
    const expiresAt = new Date(detail.fleet.expiresAt).getTime();

    return {
      ...detail,
      ttlRemainingMs: Math.max(0, expiresAt - now),
      expired: now >= expiresAt,
    };
  }
}
