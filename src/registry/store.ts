import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";

export type VMStatus = "running" | "paused" | "stopped";

export type VMRole = "infra" | "lieutenant" | "worker" | "golden" | "custom";

export interface ServiceInfo {
  name: string;
  port: number;
  healthPath?: string;
}

export interface RegisteredVM {
  id: string;
  name: string;
  role: VMRole;
  status: VMStatus;
  address: string;
  services?: ServiceInfo[];
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  registeredBy: string;
  registeredAt: string;
  lastSeen: string;
}

export interface RegisterVMInput {
  id: string;
  name: string;
  role: VMRole;
  status?: VMStatus;
  address: string;
  services?: ServiceInfo[];
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  registeredBy: string;
}

export interface UpdateVMInput {
  name?: string;
  status?: VMStatus;
  address?: string;
  services?: ServiceInfo[];
  metadata?: Record<string, unknown>;
}

export interface VMFilters {
  role?: VMRole;
  status?: VMStatus;
}

const VALID_ROLES: Set<string> = new Set(["infra", "lieutenant", "worker", "golden", "custom"]);
const VALID_STATUSES: Set<string> = new Set(["running", "paused", "stopped"]);

/** Default stale threshold in milliseconds (5 minutes) */
const DEFAULT_STALE_MS = 5 * 60 * 1000;

/** Hard TTL — entries older than this are auto-purged (1 hour) */
const HARD_TTL_MS = 60 * 60 * 1000;

/** Auto-purge interval (10 minutes) */
const AUTO_PURGE_INTERVAL_MS = 10 * 60 * 1000;

export class RegistryStore {
  private vms: Map<string, RegisteredVM> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private staleThresholdMs: number;
  private hardTtlMs: number;
  private autoPurgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    filePath = "data/registry.json",
    staleThresholdMs = DEFAULT_STALE_MS,
    options?: { hardTtlMs?: number; autoPurge?: boolean },
  ) {
    this.filePath = filePath;
    this.staleThresholdMs = staleThresholdMs;
    this.hardTtlMs = options?.hardTtlMs ?? HARD_TTL_MS;
    this.load();

    // Start auto-purge unless explicitly disabled
    if (options?.autoPurge !== false) {
      this.startAutoPurge();
    }
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.vms)) {
          for (const vm of data.vms) {
            this.vms.set(vm.id, vm);
          }
        }
      }
    } catch {
      this.vms = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const data = JSON.stringify({ vms: Array.from(this.vms.values()) }, null, 2);
    atomicWriteFileSync(this.filePath, data);
  }

  private isStale(vm: RegisteredVM): boolean {
    if (vm.pinned) return false;
    const lastSeen = new Date(vm.lastSeen).getTime();
    return Date.now() - lastSeen > this.staleThresholdMs;
  }

  register(input: RegisterVMInput): RegisteredVM {
    if (!input.id || typeof input.id !== "string" || !input.id.trim()) {
      throw new ValidationError("id is required");
    }
    if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError("name is required");
    }
    if (!input.role || !VALID_ROLES.has(input.role)) {
      throw new ValidationError(`invalid role: ${input.role}`);
    }
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }
    if (!input.address || typeof input.address !== "string" || !input.address.trim()) {
      throw new ValidationError("address is required");
    }
    if (!input.registeredBy || typeof input.registeredBy !== "string" || !input.registeredBy.trim()) {
      throw new ValidationError("registeredBy is required");
    }
    if (this.vms.has(input.id.trim())) {
      throw new ConflictError("VM already registered");
    }

    const now = new Date().toISOString();
    const vm: RegisteredVM = {
      id: input.id.trim(),
      name: input.name.trim(),
      role: input.role,
      status: input.status || "running",
      address: input.address.trim(),
      services: input.services,
      metadata: input.metadata,
      pinned: input.pinned || false,
      registeredBy: input.registeredBy.trim(),
      registeredAt: now,
      lastSeen: now,
    };

    this.vms.set(vm.id, vm);
    this.scheduleSave();
    return vm;
  }

  get(id: string): RegisteredVM | undefined {
    return this.vms.get(id);
  }

  list(filters?: VMFilters, includeStale = false): RegisteredVM[] {
    let results = Array.from(this.vms.values());

    if (filters?.role) {
      results = results.filter((vm) => vm.role === filters.role);
    }
    if (filters?.status) {
      results = results.filter((vm) => vm.status === filters.status);
    }

    // Exclude stale "running" VMs unless caller opts in
    if (!includeStale) {
      results = results.filter((vm) => {
        if (vm.status === "running" && this.isStale(vm)) return false;
        return true;
      });
    }

    // Sort by registeredAt descending
    results.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
    return results;
  }

  discover(role: VMRole): RegisteredVM[] {
    return Array.from(this.vms.values()).filter(
      (vm) => vm.role === role && vm.status === "running" && !this.isStale(vm)
    );
  }

  update(id: string, input: UpdateVMInput): RegisteredVM {
    const vm = this.vms.get(id);
    if (!vm) throw new NotFoundError("VM not found");

    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim()) {
        throw new ValidationError("name cannot be empty");
      }
      vm.name = input.name.trim();
    }
    if (input.status !== undefined) vm.status = input.status;
    if (input.address !== undefined) {
      if (typeof input.address !== "string" || !input.address.trim()) {
        throw new ValidationError("address cannot be empty");
      }
      vm.address = input.address.trim();
    }
    if (input.services !== undefined) vm.services = input.services;
    if (input.metadata !== undefined) vm.metadata = input.metadata;

    vm.lastSeen = new Date().toISOString();
    this.vms.set(id, vm);
    this.scheduleSave();
    return vm;
  }

  heartbeat(id: string): RegisteredVM {
    const vm = this.vms.get(id);
    if (!vm) throw new NotFoundError("VM not found");

    vm.lastSeen = new Date().toISOString();
    this.vms.set(id, vm);
    this.scheduleSave();
    return vm;
  }

  /**
   * Register or update a VM — idempotent. If it exists, updates fields and refreshes lastSeen.
   * Used by persistent VM auto-registration on startup.
   */
  upsert(input: RegisterVMInput): RegisteredVM {
    const existing = this.vms.get(input.id?.trim());
    if (existing) {
      // Update fields but preserve registeredAt
      existing.name = input.name?.trim() || existing.name;
      existing.role = input.role || existing.role;
      existing.status = input.status || existing.status;
      existing.address = input.address?.trim() || existing.address;
      if (input.services !== undefined) existing.services = input.services;
      if (input.metadata !== undefined) existing.metadata = input.metadata;
      if (input.pinned !== undefined) existing.pinned = input.pinned;
      existing.lastSeen = new Date().toISOString();
      this.vms.set(existing.id, existing);
      this.scheduleSave();
      return existing;
    }
    return this.register(input);
  }

  /** List VMs that are stale (lastSeen older than threshold, excluding pinned) */
  listStale(): RegisteredVM[] {
    return Array.from(this.vms.values()).filter(
      (vm) => vm.status === "running" && !vm.pinned && this.isStaleRaw(vm)
    );
  }

  /** List ALL VMs regardless of stale status */
  listAll(filters?: VMFilters): RegisteredVM[] {
    let results = Array.from(this.vms.values());
    if (filters?.role) results = results.filter((vm) => vm.role === filters.role);
    if (filters?.status) results = results.filter((vm) => vm.status === filters.status);
    results.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
    return results;
  }

  /** Raw stale check ignoring pinned flag — for internal use */
  private isStaleRaw(vm: RegisteredVM): boolean {
    const lastSeen = new Date(vm.lastSeen).getTime();
    return Date.now() - lastSeen > this.staleThresholdMs;
  }

  deregister(id: string): boolean {
    const existed = this.vms.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  clear(): void {
    this.vms.clear();
    this.scheduleSave();
  }

  /** Purge all entries past the hard TTL. Returns count of purged entries. */
  purgeStale(ttlMs?: number): number {
    const threshold = ttlMs ?? this.hardTtlMs;
    let purged = 0;
    const now = Date.now();
    for (const [id, vm] of this.vms) {
      if (now - new Date(vm.lastSeen).getTime() > threshold) {
        this.vms.delete(id);
        purged++;
      }
    }
    if (purged > 0) this.scheduleSave();
    return purged;
  }

  /** Start the auto-purge interval (removes entries past hard TTL every 10 min) */
  private startAutoPurge(): void {
    this.autoPurgeTimer = setInterval(() => {
      this.purgeStale();
    }, AUTO_PURGE_INTERVAL_MS);
    // Don't keep the process alive just for this timer
    if (this.autoPurgeTimer && typeof this.autoPurgeTimer === "object" && "unref" in this.autoPurgeTimer) {
      this.autoPurgeTimer.unref();
    }
  }

  /** Stop the auto-purge interval */
  stopAutoPurge(): void {
    if (this.autoPurgeTimer) {
      clearInterval(this.autoPurgeTimer);
      this.autoPurgeTimer = null;
    }
  }
}

export { NotFoundError, ValidationError, ConflictError } from "../errors.js";
import { NotFoundError, ValidationError, ConflictError } from "../errors.js";
