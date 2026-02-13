/**
 * Persistent VM auto-registration and self-heartbeat.
 *
 * Problem: Persistent infrastructure VMs (infra, gitea, minio) don't run pi,
 * so nothing heartbeats them. TTL purging removes them from the registry
 * every 5 minutes. This has been manually re-registered 10+ times.
 *
 * Solution: Load a config file of persistent VMs on server startup.
 * Register them with pinned=true (bypasses stale filtering) and
 * heartbeat them every 2 minutes as belt-and-suspenders.
 *
 * "Remember to do X" is an anti-pattern. This makes it automatic.
 */

import { readFileSync, existsSync } from "node:fs";
import { registryStore } from "./routes.js";
import type { VMRole, ServiceInfo } from "./store.js";

interface PersistentVMConfig {
  id: string;
  name: string;
  role: VMRole;
  address: string;
  services?: ServiceInfo[];
}

interface PersistentVMsFile {
  description?: string;
  vms: PersistentVMConfig[];
}

const CONFIG_PATH = "data/persistent-vms.json";
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function loadConfig(): PersistentVMConfig[] {
  try {
    if (!existsSync(CONFIG_PATH)) {
      console.log("[persistent] No persistent-vms.json found, skipping auto-registration");
      return [];
    }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const data: PersistentVMsFile = JSON.parse(raw);
    if (!Array.isArray(data.vms)) {
      console.warn("[persistent] persistent-vms.json has no 'vms' array");
      return [];
    }
    return data.vms;
  } catch (err) {
    console.error("[persistent] Failed to load persistent-vms.json:", err);
    return [];
  }
}

function registerPersistentVMs(vms: PersistentVMConfig[]): void {
  for (const vm of vms) {
    try {
      registryStore.upsert({
        id: vm.id,
        name: vm.name,
        role: vm.role,
        status: "running",
        address: vm.address,
        services: vm.services,
        pinned: true,
        registeredBy: "server:persistent-vms",
      });
      console.log(`[persistent] Registered ${vm.name} (${vm.id}) — pinned`);
    } catch (err) {
      console.error(`[persistent] Failed to register ${vm.name}:`, err);
    }
  }
}

function heartbeatPersistentVMs(vms: PersistentVMConfig[]): void {
  for (const vm of vms) {
    try {
      registryStore.heartbeat(vm.id);
    } catch {
      // VM might have been deregistered — re-register it
      try {
        registryStore.upsert({
          id: vm.id,
          name: vm.name,
          role: vm.role,
          status: "running",
          address: vm.address,
          services: vm.services,
          pinned: true,
          registeredBy: "server:persistent-vms",
        });
        console.log(`[persistent] Re-registered ${vm.name} after heartbeat failure`);
      } catch (err) {
        console.error(`[persistent] Failed to re-register ${vm.name}:`, err);
      }
    }
  }
}

/**
 * Initialize persistent VM registration and heartbeat loop.
 * Call this once after the server starts.
 */
export function initPersistentVMs(): void {
  const vms = loadConfig();
  if (vms.length === 0) return;

  console.log(`[persistent] Auto-registering ${vms.length} persistent VMs...`);
  registerPersistentVMs(vms);

  // Start heartbeat loop (belt-and-suspenders — pinned entries don't need it,
  // but heartbeats keep lastSeen fresh for monitoring)
  heartbeatTimer = setInterval(() => {
    heartbeatPersistentVMs(vms);
  }, HEARTBEAT_INTERVAL_MS);

  // Don't block process exit
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  console.log(`[persistent] Heartbeat loop started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the heartbeat loop (for testing/shutdown).
 */
export function stopPersistentVMs(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
