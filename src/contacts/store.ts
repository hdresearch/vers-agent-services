import Database from "better-sqlite3";
import { ulid } from "ulid";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError, NotFoundError } from "../errors.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type TrustLevel = "trusted" | "known" | "blocked";

export interface Contact {
  id: string;
  commonName: string;
  fleetName: string | null;
  endpoint: string | null;
  publicKey: string | null;
  githubUsername: string | null;
  trustLevel: TrustLevel;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactInput {
  commonName: string;
  fleetName?: string;
  endpoint?: string;
  publicKey?: string;
  githubUsername?: string;
  trustLevel?: TrustLevel;
  metadata?: Record<string, unknown>;
}

export interface UpdateContactInput {
  commonName?: string;
  fleetName?: string;
  endpoint?: string;
  publicKey?: string;
  githubUsername?: string;
  trustLevel?: TrustLevel;
  metadata?: Record<string, unknown>;
}

export interface PeerInvite {
  id: string;
  token: string;
  status: "active" | "redeemed" | "expired";
  label: string | null;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
  contactId: string | null;
}

export interface PeerAcceptInput {
  name: string;
  endpoint: string;
  publicKey: string;
  fleetName?: string;
  githubUsername?: string;
}

// ── Validation ─────────────────────────────────────────────────────────────

const VALID_TRUST_LEVELS: Set<string> = new Set(["trusted", "known", "blocked"]);

function validateTrustLevel(level: unknown): TrustLevel {
  if (!level) return "known";
  if (!VALID_TRUST_LEVELS.has(String(level))) {
    throw new ValidationError(`Invalid trustLevel. Must be one of: trusted, known, blocked`);
  }
  return String(level) as TrustLevel;
}

// ── GitHub Key Parsing ─────────────────────────────────────────────────────

/**
 * Parse GitHub keys response (one key per line).
 * Prefer ed25519, fall back to other types.
 */
export function parseGitHubKeys(body: string): { key: string; type: string } | null {
  const lines = body.trim().split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  // Prefer ed25519
  const ed25519 = lines.find((l) => l.startsWith("ssh-ed25519"));
  if (ed25519) return { key: ed25519.trim(), type: "ssh-ed25519" };

  // Fall back to first key
  const first = lines[0].trim();
  const type = first.split(" ")[0] || "unknown";
  return { key: first, type };
}

/**
 * Fetch public keys from GitHub for a username.
 */
export async function fetchGitHubKeys(username: string): Promise<{ key: string; type: string } | null> {
  const url = `https://github.com/${encodeURIComponent(username)}.keys`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "vers-agent-services/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return parseGitHubKeys(body);
  } catch {
    return null;
  }
}

// ── Store ──────────────────────────────────────────────────────────────────

export class ContactsStore {
  private db: Database.Database;

  constructor(dbPath = "data/contacts.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        commonName TEXT NOT NULL,
        fleetName TEXT,
        endpoint TEXT,
        publicKey TEXT,
        githubUsername TEXT,
        trustLevel TEXT NOT NULL DEFAULT 'known',
        metadata TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_commonName ON contacts(commonName);
      CREATE INDEX IF NOT EXISTS idx_contacts_trustLevel ON contacts(trustLevel);
      CREATE INDEX IF NOT EXISTS idx_contacts_githubUsername ON contacts(githubUsername);

      CREATE TABLE IF NOT EXISTS peer_invites (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        label TEXT,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        redeemedAt TEXT,
        redeemedBy TEXT,
        contactId TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_invites_token ON peer_invites(token);
    `);
  }

  // ── Contact CRUD ─────────────────────────────────────────────────────────

  create(input: CreateContactInput): Contact {
    if (!input.commonName?.trim()) {
      throw new ValidationError("commonName is required");
    }

    const trustLevel = validateTrustLevel(input.trustLevel);
    const now = new Date().toISOString();
    const id = ulid();

    const contact: Contact = {
      id,
      commonName: input.commonName.trim(),
      fleetName: input.fleetName?.trim() || null,
      endpoint: input.endpoint?.trim() || null,
      publicKey: input.publicKey?.trim() || null,
      githubUsername: input.githubUsername?.trim() || null,
      trustLevel,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO contacts (id, commonName, fleetName, endpoint, publicKey, githubUsername, trustLevel, metadata, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        contact.id,
        contact.commonName,
        contact.fleetName,
        contact.endpoint,
        contact.publicKey,
        contact.githubUsername,
        contact.trustLevel,
        JSON.stringify(contact.metadata),
        contact.createdAt,
        contact.updatedAt,
      );

    return contact;
  }

  get(id: string): Contact {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as any;
    if (!row) throw new NotFoundError(`Contact ${id} not found`);
    return this.rowToContact(row);
  }

  list(opts?: { trustLevel?: TrustLevel; search?: string }): Contact[] {
    let sql = "SELECT * FROM contacts";
    const params: any[] = [];
    const conditions: string[] = [];

    if (opts?.trustLevel) {
      conditions.push("trustLevel = ?");
      params.push(opts.trustLevel);
    }
    if (opts?.search) {
      conditions.push("(commonName LIKE ? OR fleetName LIKE ? OR githubUsername LIKE ?)");
      const term = `%${opts.search}%`;
      params.push(term, term, term);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY updatedAt DESC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToContact(r));
  }

  update(id: string, input: UpdateContactInput): Contact {
    const existing = this.get(id);
    const now = new Date().toISOString();

    const updated = {
      commonName: input.commonName?.trim() || existing.commonName,
      fleetName: input.fleetName !== undefined ? (input.fleetName?.trim() || null) : existing.fleetName,
      endpoint: input.endpoint !== undefined ? (input.endpoint?.trim() || null) : existing.endpoint,
      publicKey: input.publicKey !== undefined ? (input.publicKey?.trim() || null) : existing.publicKey,
      githubUsername: input.githubUsername !== undefined ? (input.githubUsername?.trim() || null) : existing.githubUsername,
      trustLevel: input.trustLevel ? validateTrustLevel(input.trustLevel) : existing.trustLevel,
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
    };

    this.db
      .prepare(
        `UPDATE contacts SET commonName = ?, fleetName = ?, endpoint = ?, publicKey = ?,
         githubUsername = ?, trustLevel = ?, metadata = ?, updatedAt = ?
         WHERE id = ?`
      )
      .run(
        updated.commonName,
        updated.fleetName,
        updated.endpoint,
        updated.publicKey,
        updated.githubUsername,
        updated.trustLevel,
        JSON.stringify(updated.metadata),
        now,
        id,
      );

    return this.get(id);
  }

  delete(id: string): void {
    const result = this.db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    if (result.changes === 0) throw new NotFoundError(`Contact ${id} not found`);
  }

  findByGithubUsername(username: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE githubUsername = ?").get(username) as any;
    return row ? this.rowToContact(row) : null;
  }

  findByEndpoint(endpoint: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE endpoint = ?").get(endpoint) as any;
    return row ? this.rowToContact(row) : null;
  }

  findByPublicKey(publicKey: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE publicKey = ?").get(publicKey) as any;
    return row ? this.rowToContact(row) : null;
  }

  // ── Peering Invites ──────────────────────────────────────────────────────

  createPeerInvite(opts?: { label?: string; expiresInHours?: number }): PeerInvite {
    const now = new Date();
    const expiresInHours = opts?.expiresInHours ?? 24;
    if (expiresInHours <= 0 || expiresInHours > 720) {
      throw new ValidationError("expiresInHours must be between 1 and 720");
    }

    const invite: PeerInvite = {
      id: ulid(),
      token: `peer_${randomBytes(32).toString("base64url")}`,
      status: "active",
      label: opts?.label?.trim() || null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInHours * 3600_000).toISOString(),
      redeemedAt: null,
      redeemedBy: null,
      contactId: null,
    };

    this.db
      .prepare(
        `INSERT INTO peer_invites (id, token, status, label, createdAt, expiresAt, redeemedAt, redeemedBy, contactId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(invite.id, invite.token, invite.status, invite.label, invite.createdAt, invite.expiresAt, null, null, null);

    return invite;
  }

  getPeerInviteByToken(token: string): PeerInvite | null {
    const row = this.db.prepare("SELECT * FROM peer_invites WHERE token = ?").get(token) as any;
    if (!row) return null;
    return row as PeerInvite;
  }

  validatePeerInvite(token: string): PeerInvite | null {
    const invite = this.getPeerInviteByToken(token);
    if (!invite) return null;
    if (invite.status !== "active") return null;
    if (new Date(invite.expiresAt) < new Date()) {
      // Auto-expire
      this.db.prepare("UPDATE peer_invites SET status = 'expired' WHERE id = ?").run(invite.id);
      return null;
    }
    return invite;
  }

  redeemPeerInvite(token: string, contactId: string, redeemedBy: string): PeerInvite {
    const invite = this.validatePeerInvite(token);
    if (!invite) throw new NotFoundError("Invite not found, expired, or already redeemed");

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE peer_invites SET status = 'redeemed', redeemedAt = ?, redeemedBy = ?, contactId = ?
         WHERE id = ?`
      )
      .run(now, redeemedBy, contactId, invite.id);

    return { ...invite, status: "redeemed", redeemedAt: now, redeemedBy, contactId };
  }

  listPeerInvites(status?: string): PeerInvite[] {
    let sql = "SELECT * FROM peer_invites";
    const params: any[] = [];
    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY createdAt DESC";
    return this.db.prepare(sql).all(...params) as PeerInvite[];
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private rowToContact(row: any): Contact {
    return {
      id: row.id,
      commonName: row.commonName,
      fleetName: row.fleetName,
      endpoint: row.endpoint,
      publicKey: row.publicKey,
      githubUsername: row.githubUsername,
      trustLevel: row.trustLevel as TrustLevel,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM contacts").get() as any;
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
