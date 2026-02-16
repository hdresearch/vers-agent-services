import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubFleet {
  id: string;
  name: string;
  purpose: string;
  goldenCommit: string;
  vmCount: number;
  ttlHours: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "destroying" | "destroyed";
  scopedToken: string;
}

export interface SubFleetVM {
  id: string;
  subfleetId: string;
  vmId: string;
  name: string;
  address: string;
  status: "spawning" | "running" | "destroying" | "destroyed" | "failed";
  createdAt: string;
  destroyedAt: string | null;
}

export interface SubFleetSummary {
  id: string;
  name: string;
  purpose: string;
  vmCount: number;
  activeVMs: number;
  createdAt: string;
  expiresAt: string;
  ttlRemainingMs: number;
  status: string;
}

export interface SubFleetDetail {
  fleet: SubFleet;
  vms: SubFleetVM[];
}

// ── Store ────────────────────────────────────────────────────────────────────

export class SubFleetStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath = "data/subfleet.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subfleets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        golden_commit TEXT NOT NULL,
        vm_count INTEGER NOT NULL,
        ttl_hours REAL NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        scoped_token TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subfleets_status ON subfleets(status);
      CREATE INDEX IF NOT EXISTS idx_subfleets_expires ON subfleets(expires_at);

      CREATE TABLE IF NOT EXISTS subfleet_vms (
        id TEXT PRIMARY KEY,
        subfleet_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'spawning',
        created_at TEXT NOT NULL,
        destroyed_at TEXT,
        FOREIGN KEY (subfleet_id) REFERENCES subfleets(id)
      );

      CREATE INDEX IF NOT EXISTS idx_subfleet_vms_fleet ON subfleet_vms(subfleet_id);
      CREATE INDEX IF NOT EXISTS idx_subfleet_vms_status ON subfleet_vms(status);

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        subfleet_id TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
    `);
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  audit(subfleetId: string | null, action: string, detail: string): void {
    this.db.prepare(
      `INSERT INTO audit_log (id, subfleet_id, action, detail, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).run(ulid(), subfleetId, action, detail, new Date().toISOString());
  }

  getAuditLog(subfleetId?: string, limit = 50): Array<{ id: string; subfleetId: string | null; action: string; detail: string; timestamp: string }> {
    if (subfleetId) {
      return this.db.prepare(
        `SELECT id, subfleet_id as subfleetId, action, detail, timestamp FROM audit_log WHERE subfleet_id = ? ORDER BY timestamp DESC LIMIT ?`
      ).all(subfleetId, limit) as any;
    }
    return this.db.prepare(
      `SELECT id, subfleet_id as subfleetId, action, detail, timestamp FROM audit_log ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as any;
  }

  // ── Sub-fleet CRUD ─────────────────────────────────────────────────────────

  /**
   * Generate a scoped token for a sub-fleet.
   * This is a random hex string — NOT the main infra token.
   * Sub-fleet VMs use this to authenticate to each other.
   */
  static generateScopedToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  create(opts: {
    name: string;
    purpose: string;
    goldenCommit: string;
    vmCount: number;
    ttlHours: number;
  }): SubFleet {
    const id = ulid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + opts.ttlHours * 60 * 60 * 1000);
    const scopedToken = SubFleetStore.generateScopedToken();

    const fleet: SubFleet = {
      id,
      name: opts.name,
      purpose: opts.purpose,
      goldenCommit: opts.goldenCommit,
      vmCount: opts.vmCount,
      ttlHours: opts.ttlHours,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "active",
      scopedToken,
    };

    this.db.prepare(`
      INSERT INTO subfleets (id, name, purpose, golden_commit, vm_count, ttl_hours, created_at, expires_at, status, scoped_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fleet.id, fleet.name, fleet.purpose, fleet.goldenCommit, fleet.vmCount, fleet.ttlHours, fleet.createdAt, fleet.expiresAt, fleet.status, fleet.scopedToken);

    this.audit(id, "created", `Sub-fleet "${opts.name}" — ${opts.vmCount} VMs, TTL ${opts.ttlHours}h`);
    return fleet;
  }

  get(id: string): SubFleet | null {
    const row = this.db.prepare(`
      SELECT id, name, purpose, golden_commit as goldenCommit, vm_count as vmCount,
             ttl_hours as ttlHours, created_at as createdAt, expires_at as expiresAt,
             status, scoped_token as scopedToken
      FROM subfleets WHERE id = ?
    `).get(id) as SubFleet | undefined;
    return row ?? null;
  }

  listActive(): SubFleetSummary[] {
    const rows = this.db.prepare(`
      SELECT s.id, s.name, s.purpose, s.vm_count as vmCount, s.created_at as createdAt,
             s.expires_at as expiresAt, s.status,
             (SELECT COUNT(*) FROM subfleet_vms v WHERE v.subfleet_id = s.id AND v.status IN ('spawning', 'running')) as activeVMs
      FROM subfleets s
      WHERE s.status IN ('active', 'destroying')
      ORDER BY s.created_at DESC
    `).all() as Array<SubFleetSummary>;

    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      ttlRemainingMs: Math.max(0, new Date(r.expiresAt).getTime() - now),
    }));
  }

  setStatus(id: string, status: SubFleet["status"]): void {
    this.db.prepare(`UPDATE subfleets SET status = ? WHERE id = ?`).run(status, id);
    this.audit(id, "status_changed", status);
  }

  extendTTL(id: string, additionalHours: number): SubFleet | null {
    const fleet = this.get(id);
    if (!fleet || fleet.status !== "active") return null;

    const currentExpiry = new Date(fleet.expiresAt);
    const newExpiry = new Date(currentExpiry.getTime() + additionalHours * 60 * 60 * 1000);
    const newTTL = fleet.ttlHours + additionalHours;

    this.db.prepare(`UPDATE subfleets SET expires_at = ?, ttl_hours = ? WHERE id = ?`)
      .run(newExpiry.toISOString(), newTTL, id);

    this.audit(id, "ttl_extended", `+${additionalHours}h → expires ${newExpiry.toISOString()}`);

    return { ...fleet, expiresAt: newExpiry.toISOString(), ttlHours: newTTL };
  }

  // ── VM Management ──────────────────────────────────────────────────────────

  addVM(subfleetId: string, vmId: string, name: string): SubFleetVM {
    const vm: SubFleetVM = {
      id: ulid(),
      subfleetId,
      vmId,
      name,
      address: `${vmId}.vm.vers.sh`,
      status: "spawning",
      createdAt: new Date().toISOString(),
      destroyedAt: null,
    };

    this.db.prepare(`
      INSERT INTO subfleet_vms (id, subfleet_id, vm_id, name, address, status, created_at, destroyed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(vm.id, vm.subfleetId, vm.vmId, vm.name, vm.address, vm.status, vm.createdAt, vm.destroyedAt);

    this.audit(subfleetId, "vm_added", `${vmId} (${name})`);
    return vm;
  }

  setVMStatus(vmId: string, status: SubFleetVM["status"]): void {
    const updates: Record<string, string | null> = { status };
    if (status === "destroyed") {
      updates.destroyed_at = new Date().toISOString();
    }
    if (updates.destroyed_at) {
      this.db.prepare(`UPDATE subfleet_vms SET status = ?, destroyed_at = ? WHERE vm_id = ?`)
        .run(status, updates.destroyed_at, vmId);
    } else {
      this.db.prepare(`UPDATE subfleet_vms SET status = ? WHERE vm_id = ?`)
        .run(status, vmId);
    }
  }

  getVMs(subfleetId: string): SubFleetVM[] {
    return this.db.prepare(`
      SELECT id, subfleet_id as subfleetId, vm_id as vmId, name, address, status,
             created_at as createdAt, destroyed_at as destroyedAt
      FROM subfleet_vms WHERE subfleet_id = ?
      ORDER BY created_at
    `).all(subfleetId) as SubFleetVM[];
  }

  getVMByVmId(vmId: string): SubFleetVM | null {
    const row = this.db.prepare(`
      SELECT id, subfleet_id as subfleetId, vm_id as vmId, name, address, status,
             created_at as createdAt, destroyed_at as destroyedAt
      FROM subfleet_vms WHERE vm_id = ?
    `).get(vmId) as SubFleetVM | undefined;
    return row ?? null;
  }

  // ── Expiry ─────────────────────────────────────────────────────────────────

  /**
   * Find sub-fleets whose TTL has expired and are still active.
   */
  getExpiredFleets(): SubFleet[] {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT id, name, purpose, golden_commit as goldenCommit, vm_count as vmCount,
             ttl_hours as ttlHours, created_at as createdAt, expires_at as expiresAt,
             status, scoped_token as scopedToken
      FROM subfleets WHERE status = 'active' AND expires_at <= ?
    `).all(now) as SubFleet[];
  }

  // ── Detail view ────────────────────────────────────────────────────────────

  getDetail(id: string): SubFleetDetail | null {
    const fleet = this.get(id);
    if (!fleet) return null;
    const vms = this.getVMs(id);
    return { fleet, vms };
  }

  close(): void {
    this.db.close();
  }
}
