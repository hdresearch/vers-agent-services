import { ulid } from "ulid";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { NotFoundError, ValidationError, ConflictError } from "../errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceLimits {
  maxCpuCores: number;
  maxMemoryMB: number;
  maxDiskGB: number;
  maxNetworkEgressGB: number;
  maxDurationHours: number;
  maxTokenBudget: number;
}

export interface Permissions {
  canAccessInternet: boolean;
  canSpawnSubAgents: boolean;
  canAccessHostServices: boolean;
}

export type InviteStatus = "active" | "redeemed" | "revoked" | "expired";

export interface Invite {
  id: string;
  code: string;
  label?: string;
  status: InviteStatus;
  resourceLimits: ResourceLimits;
  permissions: Permissions;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedBy?: string;
  guestId?: string;
}

export type GuestStatus = "provisioning" | "running" | "stopped" | "expired" | "revoked";

export interface ResourceUsage {
  cpuSeconds: number;
  memoryPeakMB: number;
  diskUsedGB: number;
  networkEgressGB: number;
  tokensUsed: number;
  uptimeSeconds: number;
}

export interface Guest {
  id: string;
  name: string;
  publicKey?: string;
  status: GuestStatus;
  vmId?: string;
  agentEndpoint?: string;
  authToken: string;
  inviteId: string;
  resourceLimits: ResourceLimits;
  permissions: Permissions;
  resourceUsage: ResourceUsage;
  createdAt: string;
  expiresAt: string;
  stoppedAt?: string;
}

export interface CreateInviteInput {
  label?: string;
  resourceLimits?: Partial<ResourceLimits>;
  permissions?: Partial<Permissions>;
  expiresInHours?: number;
  createdBy: string;
}

export interface RedeemInviteInput {
  code: string;
  name: string;
  publicKey?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxCpuCores: 2,
  maxMemoryMB: 4096,
  maxDiskGB: 20,
  maxNetworkEgressGB: 10,
  maxDurationHours: 72,
  maxTokenBudget: 50_000_000,
};

const DEFAULT_PERMISSIONS: Permissions = {
  canAccessInternet: true,
  canSpawnSubAgents: false,
  canAccessHostServices: false,
};

const DEFAULT_INVITE_EXPIRY_HOURS = 24;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface StoreData {
  invites: Invite[];
  guests: Guest[];
}

export class CouchStore {
  private invites: Map<string, Invite> = new Map();
  private invitesByCode: Map<string, string> = new Map(); // code → id
  private guests: Map<string, Guest> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/couch.json") {
    this.filePath = filePath;
    this.load();
  }

  // ---- Persistence --------------------------------------------------------

  private load(): void {
    recoverTmpFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data: StoreData = JSON.parse(raw);
        if (Array.isArray(data.invites)) {
          for (const inv of data.invites) {
            this.invites.set(inv.id, inv);
            if (inv.status === "active") {
              this.invitesByCode.set(inv.code, inv.id);
            }
          }
        }
        if (Array.isArray(data.guests)) {
          for (const g of data.guests) {
            this.guests.set(g.id, g);
          }
        }
      }
    } catch {
      this.invites = new Map();
      this.invitesByCode = new Map();
      this.guests = new Map();
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
    const data: StoreData = {
      invites: Array.from(this.invites.values()),
      guests: Array.from(this.guests.values()),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  // ---- Invite Management --------------------------------------------------

  createInvite(input: CreateInviteInput): Invite {
    if (!input.createdBy?.trim()) {
      throw new ValidationError("createdBy is required");
    }

    const expiresInHours = input.expiresInHours ?? DEFAULT_INVITE_EXPIRY_HOURS;
    if (expiresInHours <= 0 || expiresInHours > 720) {
      throw new ValidationError("expiresInHours must be between 1 and 720 (30 days)");
    }

    const limits = { ...DEFAULT_RESOURCE_LIMITS, ...input.resourceLimits };
    if (limits.maxDurationHours > 720) {
      throw new ValidationError("maxDurationHours cannot exceed 720 (30 days)");
    }

    const permissions = { ...DEFAULT_PERMISSIONS, ...input.permissions };
    const now = new Date();
    const code = `inv_${randomBytes(24).toString("base64url")}`;

    const invite: Invite = {
      id: ulid(),
      code,
      label: input.label?.trim(),
      status: "active",
      resourceLimits: limits,
      permissions,
      createdBy: input.createdBy.trim(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInHours * 3600_000).toISOString(),
    };

    this.invites.set(invite.id, invite);
    this.invitesByCode.set(invite.code, invite.id);
    this.scheduleSave();
    return invite;
  }

  getInvite(id: string): Invite | undefined {
    return this.invites.get(id);
  }

  getInviteByCode(code: string): Invite | undefined {
    const id = this.invitesByCode.get(code);
    return id ? this.invites.get(id) : undefined;
  }

  listInvites(statusFilter?: InviteStatus): Invite[] {
    this.expireStaleInvites();
    let results = Array.from(this.invites.values());
    if (statusFilter) {
      results = results.filter((i) => i.status === statusFilter);
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  revokeInvite(id: string): Invite {
    const invite = this.invites.get(id);
    if (!invite) throw new NotFoundError("invite not found");
    if (invite.status !== "active") {
      throw new ValidationError(`cannot revoke invite with status '${invite.status}'`);
    }
    invite.status = "revoked";
    this.invitesByCode.delete(invite.code);
    this.invites.set(id, invite);
    this.scheduleSave();
    return invite;
  }

  // ---- Invite Redemption --------------------------------------------------

  redeemInvite(input: RedeemInviteInput): Guest {
    if (!input.code?.trim()) throw new ValidationError("code is required");
    if (!input.name?.trim()) throw new ValidationError("name is required");

    this.expireStaleInvites();

    const invite = this.getInviteByCode(input.code.trim());
    if (!invite) throw new NotFoundError("invite not found or expired");
    if (invite.status !== "active") {
      throw new ConflictError(`invite is ${invite.status} — cannot redeem`);
    }

    // Mark invite as redeemed
    invite.status = "redeemed";
    invite.redeemedAt = new Date().toISOString();
    invite.redeemedBy = input.name.trim();
    this.invitesByCode.delete(invite.code);

    // Create guest
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + invite.resourceLimits.maxDurationHours * 3600_000,
    ).toISOString();

    const guest: Guest = {
      id: ulid(),
      name: input.name.trim(),
      publicKey: input.publicKey?.trim(),
      status: "provisioning",
      authToken: `guest_${randomBytes(32).toString("base64url")}`,
      inviteId: invite.id,
      resourceLimits: { ...invite.resourceLimits },
      permissions: { ...invite.permissions },
      resourceUsage: {
        cpuSeconds: 0,
        memoryPeakMB: 0,
        diskUsedGB: 0,
        networkEgressGB: 0,
        tokensUsed: 0,
        uptimeSeconds: 0,
      },
      createdAt: now.toISOString(),
      expiresAt,
    };

    invite.guestId = guest.id;
    this.invites.set(invite.id, invite);
    this.guests.set(guest.id, guest);
    this.scheduleSave();

    return guest;
  }

  // ---- Guest Management ---------------------------------------------------

  getGuest(id: string): Guest | undefined {
    return this.guests.get(id);
  }

  getGuestByToken(token: string): Guest | undefined {
    for (const g of this.guests.values()) {
      if (g.authToken === token && (g.status === "running" || g.status === "provisioning")) {
        return g;
      }
    }
    return undefined;
  }

  listGuests(statusFilter?: GuestStatus): Guest[] {
    this.expireStaleGuests();
    let results = Array.from(this.guests.values());
    if (statusFilter) {
      results = results.filter((g) => g.status === statusFilter);
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  /** Mark guest as running after VM provisioning completes */
  activateGuest(id: string, vmId: string, agentEndpoint: string): Guest {
    const guest = this.guests.get(id);
    if (!guest) throw new NotFoundError("guest not found");
    if (guest.status !== "provisioning") {
      throw new ValidationError(`cannot activate guest with status '${guest.status}'`);
    }
    guest.status = "running";
    guest.vmId = vmId;
    guest.agentEndpoint = agentEndpoint;
    this.guests.set(id, guest);
    this.scheduleSave();
    return guest;
  }

  /** Update resource usage counters */
  updateUsage(id: string, usage: Partial<ResourceUsage>): Guest {
    const guest = this.guests.get(id);
    if (!guest) throw new NotFoundError("guest not found");

    const u = guest.resourceUsage;
    if (usage.cpuSeconds !== undefined) u.cpuSeconds = usage.cpuSeconds;
    if (usage.memoryPeakMB !== undefined) u.memoryPeakMB = usage.memoryPeakMB;
    if (usage.diskUsedGB !== undefined) u.diskUsedGB = usage.diskUsedGB;
    if (usage.networkEgressGB !== undefined) u.networkEgressGB = usage.networkEgressGB;
    if (usage.tokensUsed !== undefined) u.tokensUsed = usage.tokensUsed;
    if (usage.uptimeSeconds !== undefined) u.uptimeSeconds = usage.uptimeSeconds;

    this.guests.set(id, guest);
    this.scheduleSave();
    return guest;
  }

  /** Check if a guest has exceeded any resource limit */
  checkLimits(id: string): { exceeded: boolean; violations: string[] } {
    const guest = this.guests.get(id);
    if (!guest) throw new NotFoundError("guest not found");

    const violations: string[] = [];
    const u = guest.resourceUsage;
    const l = guest.resourceLimits;

    if (u.tokensUsed > l.maxTokenBudget) {
      violations.push(`tokens: ${u.tokensUsed}/${l.maxTokenBudget}`);
    }
    if (u.diskUsedGB > l.maxDiskGB) {
      violations.push(`disk: ${u.diskUsedGB}GB/${l.maxDiskGB}GB`);
    }
    if (u.networkEgressGB > l.maxNetworkEgressGB) {
      violations.push(`network: ${u.networkEgressGB}GB/${l.maxNetworkEgressGB}GB`);
    }
    const elapsedHours = u.uptimeSeconds / 3600;
    if (elapsedHours > l.maxDurationHours) {
      violations.push(`duration: ${elapsedHours.toFixed(1)}h/${l.maxDurationHours}h`);
    }

    return { exceeded: violations.length > 0, violations };
  }

  /** Kill switch — immediately stop a guest */
  killGuest(id: string): Guest {
    const guest = this.guests.get(id);
    if (!guest) throw new NotFoundError("guest not found");
    if (guest.status === "stopped" || guest.status === "revoked") {
      throw new ValidationError(`guest already ${guest.status}`);
    }
    guest.status = "revoked";
    guest.stoppedAt = new Date().toISOString();
    this.guests.set(id, guest);
    this.scheduleSave();
    return guest;
  }

  // ---- Expiration ---------------------------------------------------------

  private expireStaleInvites(): void {
    const now = Date.now();
    let changed = false;
    for (const inv of this.invites.values()) {
      if (inv.status === "active" && new Date(inv.expiresAt).getTime() <= now) {
        inv.status = "expired";
        this.invitesByCode.delete(inv.code);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  private expireStaleGuests(): void {
    const now = Date.now();
    let changed = false;
    for (const guest of this.guests.values()) {
      if (
        (guest.status === "running" || guest.status === "provisioning") &&
        new Date(guest.expiresAt).getTime() <= now
      ) {
        guest.status = "expired";
        guest.stoppedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }
}

export { NotFoundError, ValidationError, ConflictError };
