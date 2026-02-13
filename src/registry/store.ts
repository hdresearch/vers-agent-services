import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

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

export class RegistryStore {
  private vms: Map<string, RegisteredVM> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private staleThresholdMs: number;

  constructor(filePath = "data/registry.json", staleThresholdMs = DEFAULT_STALE_MS) {
    this.filePath = filePath;
    this.staleThresholdMs = staleThresholdMs;
    this.load();
  }

  private load(): void {
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
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify({ vms: Array.from(this.vms.values()) }, null, 2);
    writeFileSync(this.filePath, data, "utf-8");
  }

  private isStale(vm: RegisteredVM): boolean {
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

  list(filters?: VMFilters, excludeStale = false): RegisteredVM[] {
    let results = Array.from(this.vms.values());

    if (filters?.role) {
      results = results.filter((vm) => vm.role === filters.role);
    }
    if (filters?.status) {
      if (filters.status === "running" || excludeStale) {
        // When filtering for running, exclude stale VMs
        results = results.filter((vm) => {
          if (filters.status && vm.status !== filters.status) return false;
          if (vm.status === "running" && this.isStale(vm)) return false;
          return true;
        });
      } else {
        results = results.filter((vm) => vm.status === filters.status);
      }
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

  deregister(id: string): boolean {
    const existed = this.vms.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  clear(): void {
    this.vms.clear();
    this.scheduleSave();
  }
}

export { NotFoundError, ValidationError, ConflictError } from "../errors.js";
import { NotFoundError, ValidationError, ConflictError } from "../errors.js";
