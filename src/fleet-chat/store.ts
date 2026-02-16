import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError, NotFoundError } from "../errors.js";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { signContent, verifyContent, isRealSignature, decryptContent } from "./crypto.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type MessageType = "text" | "task" | "seed" | "announcement" | "ack" | "system" | "encrypted";
export type DeliveryStatus = "pending" | "delivered" | "read" | "failed";
export type ChannelStatus = "active" | "archived" | "closed";

export interface FleetIdentity {
  name: string;
  endpoint: string;
  publicKey: string;
}

export interface TrustedEndpoint {
  name: string;
  endpoint: string;
  publicKey: string;
  addedAt: string;
  notes?: string;
}

export interface Channel {
  id: string;
  localFleet: FleetIdentity;
  remoteFleet: FleetIdentity;
  status: ChannelStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  threadId: string;
  from: FleetIdentity;
  to: FleetIdentity;
  type: MessageType;
  content: string;
  timestamp: string;
  signature: string;
  delivery: DeliveryStatus;
  deliveredAt?: string;
  readAt?: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface QuarantinedMessage {
  id: string;
  rawMessage: InboundMessage;
  reason: string;
  receivedAt: string;
  reviewed: boolean;
}

export interface InboundMessage {
  id?: string;
  channelId?: string;
  threadId?: string;
  from: FleetIdentity;
  to: FleetIdentity;
  type: MessageType;
  content: string;
  timestamp: string;
  signature: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageInput {
  channelId: string;
  content: string;
  type?: MessageType;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateChannelInput {
  remoteFleet: FleetIdentity;
  metadata?: Record<string, unknown>;
}

export interface StoreData {
  channels: Channel[];
  messages: ChatMessage[];
  trustedEndpoints: TrustedEndpoint[];
  quarantine: QuarantinedMessage[];
  localIdentity: FleetIdentity | null;
}

// ── Crypto helpers ─────────────────────────────────────────────────────────

/**
 * Sign message content with Ed25519 private key.
 * In production, the fleet's SSH key would be used. For now we use
 * a simple HMAC-like hash when no private key is available, or Ed25519
 * when a key pair is provided.
 */
export function signMessage(content: string, timestamp: string, privateKey?: string): string {
  if (privateKey) {
    try {
      const sign = createSign("SHA256");
      sign.update(`${content}|${timestamp}`);
      sign.end();
      return sign.sign(privateKey, "base64url");
    } catch {
      // Fall back to hash-based signature
    }
  }
  // Simple hash-based signature (for development / when no private key)
  return createHash("sha256").update(`${content}|${timestamp}`).digest("base64url");
}

/**
 * Verify a message signature against a public key.
 * Returns true if the signature is valid.
 */
export function verifySignature(
  content: string,
  timestamp: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const verify = createVerify("SHA256");
    verify.update(`${content}|${timestamp}`);
    verify.end();
    return verify.verify(publicKey, signature, "base64url");
  } catch {
    // If public key verification fails (e.g., hash-based sig), check hash match
    const expected = createHash("sha256").update(`${content}|${timestamp}`).digest("base64url");
    return signature === expected;
  }
}

/**
 * Generate an Ed25519 key pair for testing/development.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

// ── Validation ─────────────────────────────────────────────────────────────

const VALID_MESSAGE_TYPES: Set<string> = new Set(["text", "task", "seed", "announcement", "ack", "system", "encrypted"]);
const VALID_CHANNEL_STATUSES: Set<string> = new Set(["active", "archived", "closed"]);
const MAX_CONTENT_LENGTH = 64 * 1024; // 64KB per message

function validateFleetIdentity(fleet: unknown, label: string): FleetIdentity {
  if (!fleet || typeof fleet !== "object") {
    throw new ValidationError(`${label} must be an object with name, endpoint, publicKey`);
  }
  const f = fleet as Record<string, unknown>;
  if (!f.name || typeof f.name !== "string") throw new ValidationError(`${label}.name is required`);
  if (!f.endpoint || typeof f.endpoint !== "string") throw new ValidationError(`${label}.endpoint is required`);
  if (!f.publicKey || typeof f.publicKey !== "string") throw new ValidationError(`${label}.publicKey is required`);
  return { name: String(f.name).trim(), endpoint: String(f.endpoint).trim(), publicKey: String(f.publicKey).trim() };
}

// ── Store ──────────────────────────────────────────────────────────────────

export class FleetChatStore {
  private db: Database.Database;
  private privateKey?: string;
  private privateKeyPath?: string;
  private requireSignatures: boolean;
  private sseListeners: Set<(msg: ChatMessage) => void> = new Set();

  constructor(
    dbPath = "data/fleet-chat.db",
    privateKey?: string,
    opts?: { privateKeyPath?: string; requireSignatures?: boolean },
  ) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.privateKey = privateKey;
    this.privateKeyPath = opts?.privateKeyPath;
    this.requireSignatures = opts?.requireSignatures ?? (process.env.REQUIRE_SIGNATURES === "true");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        localFleetName TEXT NOT NULL,
        localFleetEndpoint TEXT NOT NULL,
        localFleetPublicKey TEXT NOT NULL,
        remoteFleetName TEXT NOT NULL,
        remoteFleetEndpoint TEXT NOT NULL,
        remoteFleetPublicKey TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastMessageAt TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);
      CREATE INDEX IF NOT EXISTS idx_channels_remoteEndpoint ON channels(remoteFleetEndpoint);
      CREATE INDEX IF NOT EXISTS idx_channels_remotePublicKey ON channels(remoteFleetPublicKey);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channelId TEXT NOT NULL,
        threadId TEXT NOT NULL,
        fromName TEXT NOT NULL,
        fromEndpoint TEXT NOT NULL,
        fromPublicKey TEXT NOT NULL,
        toName TEXT NOT NULL,
        toEndpoint TEXT NOT NULL,
        toPublicKey TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        signature TEXT NOT NULL,
        delivery TEXT NOT NULL DEFAULT 'pending',
        deliveredAt TEXT,
        readAt TEXT,
        replyTo TEXT,
        metadata TEXT,
        FOREIGN KEY (channelId) REFERENCES channels(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channelId ON messages(channelId);
      CREATE INDEX IF NOT EXISTS idx_messages_threadId ON messages(threadId);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS trusted_peers (
        endpoint TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        addedAt TEXT NOT NULL,
        notes TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trusted_peers_publicKey ON trusted_peers(publicKey);

      CREATE TABLE IF NOT EXISTS quarantine (
        id TEXT PRIMARY KEY,
        rawMessage TEXT NOT NULL,
        reason TEXT NOT NULL,
        receivedAt TEXT NOT NULL,
        reviewed INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_quarantine_receivedAt ON quarantine(receivedAt);

      CREATE TABLE IF NOT EXISTS local_identity (
        key TEXT PRIMARY KEY DEFAULT 'identity',
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        publicKey TEXT NOT NULL
      );
    `);
  }

  // ── Row → Object helpers ─────────────────────────────────────────────────

  private rowToChannel(row: any): Channel {
    return {
      id: row.id,
      localFleet: { name: row.localFleetName, endpoint: row.localFleetEndpoint, publicKey: row.localFleetPublicKey },
      remoteFleet: { name: row.remoteFleetName, endpoint: row.remoteFleetEndpoint, publicKey: row.remoteFleetPublicKey },
      status: row.status as ChannelStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastMessageAt: row.lastMessageAt || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private rowToMessage(row: any): ChatMessage {
    return {
      id: row.id,
      channelId: row.channelId,
      threadId: row.threadId,
      from: { name: row.fromName, endpoint: row.fromEndpoint, publicKey: row.fromPublicKey },
      to: { name: row.toName, endpoint: row.toEndpoint, publicKey: row.toPublicKey },
      type: row.type as MessageType,
      content: row.content,
      timestamp: row.timestamp,
      signature: row.signature,
      delivery: row.delivery as DeliveryStatus,
      deliveredAt: row.deliveredAt || undefined,
      readAt: row.readAt || undefined,
      replyTo: row.replyTo || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private rowToTrustedEndpoint(row: any): TrustedEndpoint {
    return {
      name: row.name,
      endpoint: row.endpoint,
      publicKey: row.publicKey,
      addedAt: row.addedAt,
      notes: row.notes || undefined,
    };
  }

  private rowToQuarantined(row: any): QuarantinedMessage {
    return {
      id: row.id,
      rawMessage: JSON.parse(row.rawMessage),
      reason: row.reason,
      receivedAt: row.receivedAt,
      reviewed: !!row.reviewed,
    };
  }

  // ── Local Identity ───────────────────────────────────────────────────────

  setLocalIdentity(identity: FleetIdentity): void {
    const validated = validateFleetIdentity(identity, "localIdentity");
    this.db
      .prepare(
        `INSERT OR REPLACE INTO local_identity (key, name, endpoint, publicKey)
         VALUES ('identity', ?, ?, ?)`
      )
      .run(validated.name, validated.endpoint, validated.publicKey);
  }

  getLocalIdentity(): FleetIdentity | null {
    const row = this.db.prepare("SELECT * FROM local_identity WHERE key = 'identity'").get() as any;
    if (!row) return null;
    return { name: row.name, endpoint: row.endpoint, publicKey: row.publicKey };
  }

  setPrivateKey(key: string): void {
    this.privateKey = key;
  }

  setPrivateKeyPath(path: string): void {
    this.privateKeyPath = path;
  }

  getPrivateKeyPath(): string | undefined {
    return this.privateKeyPath;
  }

  setRequireSignatures(require: boolean): void {
    this.requireSignatures = require;
  }

  // ── Trusted Endpoints ────────────────────────────────────────────────────

  addTrustedEndpoint(endpoint: Omit<TrustedEndpoint, "addedAt">): TrustedEndpoint {
    const validated = validateFleetIdentity(endpoint, "trustedEndpoint");

    // Check existing by endpoint or publicKey
    const existing = this.db
      .prepare("SELECT * FROM trusted_peers WHERE endpoint = ? OR publicKey = ?")
      .get(validated.endpoint, validated.publicKey) as any;

    if (existing) {
      // Update existing
      this.db
        .prepare(
          `UPDATE trusted_peers SET name = ?, endpoint = ?, publicKey = ?, notes = ?
           WHERE endpoint = ? OR publicKey = ?`
        )
        .run(
          validated.name,
          validated.endpoint,
          validated.publicKey,
          (endpoint as TrustedEndpoint).notes || existing.notes || null,
          validated.endpoint,
          validated.publicKey,
        );
      return this.rowToTrustedEndpoint(
        this.db.prepare("SELECT * FROM trusted_peers WHERE endpoint = ?").get(validated.endpoint),
      );
    }

    const entry: TrustedEndpoint = {
      ...validated,
      addedAt: new Date().toISOString(),
      notes: (endpoint as TrustedEndpoint).notes,
    };

    this.db
      .prepare(
        `INSERT INTO trusted_peers (endpoint, name, publicKey, addedAt, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.endpoint, entry.name, entry.publicKey, entry.addedAt, entry.notes || null);

    return entry;
  }

  removeTrustedEndpoint(endpoint: string): boolean {
    const result = this.db.prepare("DELETE FROM trusted_peers WHERE endpoint = ?").run(endpoint);
    return result.changes > 0;
  }

  getTrustedEndpoints(): TrustedEndpoint[] {
    const rows = this.db.prepare("SELECT * FROM trusted_peers ORDER BY addedAt DESC").all() as any[];
    return rows.map((r) => this.rowToTrustedEndpoint(r));
  }

  isTrusted(endpoint?: string, publicKey?: string): boolean {
    if (!endpoint && !publicKey) return false;
    const conditions: string[] = [];
    const params: any[] = [];
    if (endpoint) {
      conditions.push("endpoint = ?");
      params.push(endpoint);
    }
    if (publicKey) {
      conditions.push("publicKey = ?");
      params.push(publicKey);
    }
    const row = this.db
      .prepare(`SELECT 1 FROM trusted_peers WHERE ${conditions.join(" OR ")} LIMIT 1`)
      .get(...params);
    return !!row;
  }

  findTrustedByKey(publicKey: string): TrustedEndpoint | undefined {
    const row = this.db.prepare("SELECT * FROM trusted_peers WHERE publicKey = ?").get(publicKey) as any;
    return row ? this.rowToTrustedEndpoint(row) : undefined;
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  createChannel(input: CreateChannelInput): Channel {
    const localIdentity = this.getLocalIdentity();
    if (!localIdentity) throw new ValidationError("Local identity must be set before creating channels");

    const remoteFleet = validateFleetIdentity(input.remoteFleet, "remoteFleet");

    // Check for existing active channel with this fleet
    const existing = this.db
      .prepare(
        `SELECT * FROM channels WHERE status = 'active'
         AND (remoteFleetEndpoint = ? OR remoteFleetPublicKey = ?)`
      )
      .get(remoteFleet.endpoint, remoteFleet.publicKey) as any;
    if (existing) return this.rowToChannel(existing); // Idempotent

    const now = new Date().toISOString();
    const channel: Channel = {
      id: ulid(),
      localFleet: { ...localIdentity },
      remoteFleet,
      status: "active",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.db
      .prepare(
        `INSERT INTO channels (id, localFleetName, localFleetEndpoint, localFleetPublicKey,
         remoteFleetName, remoteFleetEndpoint, remoteFleetPublicKey, status, createdAt, updatedAt,
         lastMessageAt, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        channel.id,
        localIdentity.name,
        localIdentity.endpoint,
        localIdentity.publicKey,
        remoteFleet.name,
        remoteFleet.endpoint,
        remoteFleet.publicKey,
        channel.status,
        channel.createdAt,
        channel.updatedAt,
        null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );

    // Auto-add remote fleet to trusted endpoints if not already trusted
    if (!this.isTrusted(remoteFleet.endpoint, remoteFleet.publicKey)) {
      this.addTrustedEndpoint(remoteFleet);
    }

    return channel;
  }

  getChannel(id: string): Channel {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as any;
    if (!row) throw new NotFoundError(`Channel ${id} not found`);
    return this.rowToChannel(row);
  }

  listChannels(opts?: { status?: ChannelStatus }): Channel[] {
    let sql = "SELECT * FROM channels";
    const params: any[] = [];
    if (opts?.status) {
      sql += " WHERE status = ?";
      params.push(opts.status);
    }
    sql += " ORDER BY updatedAt DESC";
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToChannel(r));
  }

  findChannelByRemote(endpoint?: string, publicKey?: string): Channel | undefined {
    const conditions: string[] = ["status = 'active'"];
    const params: any[] = [];
    const remoteConditions: string[] = [];
    if (endpoint) {
      remoteConditions.push("remoteFleetEndpoint = ?");
      params.push(endpoint);
    }
    if (publicKey) {
      remoteConditions.push("remoteFleetPublicKey = ?");
      params.push(publicKey);
    }
    if (remoteConditions.length === 0) return undefined;
    conditions.push(`(${remoteConditions.join(" OR ")})`);

    const row = this.db
      .prepare(`SELECT * FROM channels WHERE ${conditions.join(" AND ")} LIMIT 1`)
      .get(...params) as any;
    return row ? this.rowToChannel(row) : undefined;
  }

  updateChannelStatus(id: string, status: ChannelStatus): Channel {
    this.getChannel(id); // Verify exists
    if (!VALID_CHANNEL_STATUSES.has(status)) {
      throw new ValidationError(`Invalid status. Must be one of: ${[...VALID_CHANNEL_STATUSES].join(", ")}`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE channels SET status = ?, updatedAt = ? WHERE id = ?")
      .run(status, now, id);
    return this.getChannel(id);
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<ChatMessage> {
    const channel = this.getChannel(input.channelId);
    if (channel.status !== "active") {
      throw new ValidationError(`Channel ${input.channelId} is ${channel.status}, cannot send messages`);
    }
    if (!input.content?.trim()) throw new ValidationError("Message content is required");
    if (input.content.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Message content exceeds max length of ${MAX_CONTENT_LENGTH} bytes`);
    }

    const type = input.type || "text";
    if (!VALID_MESSAGE_TYPES.has(type)) {
      throw new ValidationError(`Invalid message type. Must be one of: ${[...VALID_MESSAGE_TYPES].join(", ")}`);
    }

    // Determine thread
    let threadId: string;
    if (input.replyTo) {
      const parent = this.db.prepare("SELECT threadId FROM messages WHERE id = ?").get(input.replyTo) as any;
      if (!parent) throw new NotFoundError(`Message ${input.replyTo} not found`);
      threadId = parent.threadId;
    } else {
      threadId = ulid();
    }

    const now = new Date().toISOString();
    const content = input.content.trim();

    // Sign with real Ed25519 if privateKeyPath is available, else fallback
    let sig: string;
    if (this.privateKeyPath) {
      sig = await signContent(content, this.privateKeyPath);
    } else {
      sig = signMessage(content, now, this.privateKey);
    }

    const msg: ChatMessage = {
      id: ulid(),
      channelId: channel.id,
      threadId,
      from: { ...channel.localFleet },
      to: { ...channel.remoteFleet },
      type,
      content,
      timestamp: now,
      signature: sig,
      delivery: "pending",
      replyTo: input.replyTo,
      metadata: input.metadata,
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, channelId, threadId, fromName, fromEndpoint, fromPublicKey,
         toName, toEndpoint, toPublicKey, type, content, timestamp, signature, delivery,
         deliveredAt, readAt, replyTo, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id, msg.channelId, msg.threadId,
        msg.from.name, msg.from.endpoint, msg.from.publicKey,
        msg.to.name, msg.to.endpoint, msg.to.publicKey,
        msg.type, msg.content, msg.timestamp, msg.signature, msg.delivery,
        null, null, msg.replyTo || null,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
      );

    // Update channel timestamps
    this.db
      .prepare("UPDATE channels SET lastMessageAt = ?, updatedAt = ? WHERE id = ?")
      .run(now, now, channel.id);

    return msg;
  }

  getMessages(
    channelId: string,
    opts?: { limit?: number; after?: string; before?: string; threadId?: string },
  ): ChatMessage[] {
    this.getChannel(channelId); // Verify channel exists

    const conditions: string[] = ["channelId = ?"];
    const params: any[] = [channelId];

    if (opts?.threadId) {
      conditions.push("threadId = ?");
      params.push(opts.threadId);
    }
    if (opts?.after) {
      conditions.push("timestamp > ?");
      params.push(opts.after);
    }
    if (opts?.before) {
      conditions.push("timestamp < ?");
      params.push(opts.before);
    }

    let sql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY id ASC`;

    if (opts?.limit) {
      // Last N messages: use a subquery to get the tail (order by ULID for deterministic ordering)
      sql = `SELECT * FROM (
        SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?
      ) sub ORDER BY id ASC`;
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToMessage(r));
  }

  updateDelivery(messageId: string, status: DeliveryStatus): ChatMessage {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as any;
    if (!row) throw new NotFoundError(`Message ${messageId} not found`);

    const updates: string[] = ["delivery = ?"];
    const params: any[] = [status];

    if (status === "delivered") {
      updates.push("deliveredAt = ?");
      params.push(new Date().toISOString());
    }
    if (status === "read") {
      updates.push("readAt = ?");
      params.push(new Date().toISOString());
    }

    params.push(messageId);
    this.db.prepare(`UPDATE messages SET ${updates.join(", ")} WHERE id = ?`).run(...params);

    return this.rowToMessage(
      this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId),
    );
  }

  // ── Inbound (Public Inbox) ───────────────────────────────────────────────

  async receiveInbound(inbound: InboundMessage): Promise<{ message?: ChatMessage; quarantined?: QuarantinedMessage }> {
    // Accept both "from" and "sender" field names for compatibility
    const rawFrom = inbound.from || (inbound as any).sender;
    const rawTo = inbound.to || (inbound as any).recipient;

    // Validate sender identity
    const from = validateFleetIdentity(rawFrom, "from");
    const to = validateFleetIdentity(rawTo, "to");

    if (!inbound.content?.trim()) throw new ValidationError("Message content is required");
    if (inbound.content.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Message content exceeds max length of ${MAX_CONTENT_LENGTH} bytes`);
    }
    if (!inbound.signature) throw new ValidationError("Message signature is required");
    if (!inbound.timestamp) throw new ValidationError("Message timestamp is required");

    const type = inbound.type || "text";
    if (!VALID_MESSAGE_TYPES.has(type)) {
      throw new ValidationError(`Invalid message type. Must be one of: ${[...VALID_MESSAGE_TYPES].join(", ")}`);
    }

    // Check: is sender trusted?
    const trusted = this.isTrusted(from.endpoint, from.publicKey);

    if (!trusted) {
      // Quarantine unknown senders
      const quarantined: QuarantinedMessage = {
        id: ulid(),
        rawMessage: inbound,
        reason: `Unknown sender: ${from.name} (${from.endpoint})`,
        receivedAt: new Date().toISOString(),
        reviewed: false,
      };
      this.db
        .prepare("INSERT INTO quarantine (id, rawMessage, reason, receivedAt, reviewed) VALUES (?, ?, ?, ?, ?)")
        .run(quarantined.id, JSON.stringify(inbound), quarantined.reason, quarantined.receivedAt, 0);
      return { quarantined };
    }

    // ── Signature verification for trusted senders ─────────────────────
    const sig = inbound.signature;
    const hasRealSig = sig && isRealSignature(sig);

    if (hasRealSig) {
      const valid = verifyContent(inbound.content, sig, from.publicKey);
      if (!valid) {
        const quarantined: QuarantinedMessage = {
          id: ulid(),
          rawMessage: inbound,
          reason: `Invalid Ed25519 signature from trusted sender: ${from.name}`,
          receivedAt: new Date().toISOString(),
          reviewed: false,
        };
        this.db
          .prepare("INSERT INTO quarantine (id, rawMessage, reason, receivedAt, reviewed) VALUES (?, ?, ?, ?, ?)")
          .run(quarantined.id, JSON.stringify(inbound), quarantined.reason, quarantined.receivedAt, 0);
        return { quarantined };
      }
    } else if (this.requireSignatures) {
      const quarantined: QuarantinedMessage = {
        id: ulid(),
        rawMessage: inbound,
        reason: `Missing Ed25519 signature from trusted sender: ${from.name} (signatures required)`,
        receivedAt: new Date().toISOString(),
        reviewed: false,
      };
      this.db
        .prepare("INSERT INTO quarantine (id, rawMessage, reason, receivedAt, reviewed) VALUES (?, ?, ?, ?, ?)")
        .run(quarantined.id, JSON.stringify(inbound), quarantined.reason, quarantined.receivedAt, 0);
      return { quarantined };
    }

    // Find or create channel for this sender
    let channel = this.findChannelByRemote(from.endpoint, from.publicKey);
    if (!channel) {
      const localIdentity = this.getLocalIdentity();
      if (localIdentity) {
        channel = this.createChannel({ remoteFleet: from });
      } else {
        throw new ValidationError("Local identity not set, cannot receive messages");
      }
    }

    // Determine thread
    let threadId: string;
    if (inbound.replyTo) {
      const parent = this.db.prepare("SELECT threadId FROM messages WHERE id = ?").get(inbound.replyTo) as any;
      threadId = parent?.threadId || inbound.threadId || ulid();
    } else {
      threadId = inbound.threadId || ulid();
    }

    const now = new Date().toISOString();

    // ── Decrypt encrypted messages ────────────────────────────────────
    let finalContent = inbound.content.trim();
    let finalType: MessageType = type;

    if (type === "encrypted" && this.privateKeyPath) {
      try {
        finalContent = await decryptContent(inbound.content.trim(), this.privateKeyPath);
        finalType = "text";
      } catch (err) {
        const quarantined: QuarantinedMessage = {
          id: ulid(),
          rawMessage: inbound,
          reason: `Decryption failed: ${(err as Error).message}`,
          receivedAt: now,
          reviewed: false,
        };
        this.db
          .prepare("INSERT INTO quarantine (id, rawMessage, reason, receivedAt, reviewed) VALUES (?, ?, ?, ?, ?)")
          .run(quarantined.id, JSON.stringify(inbound), quarantined.reason, quarantined.receivedAt, 0);
        return { quarantined };
      }
    }

    const msgId = inbound.id || ulid();

    // Deduplicate — if we already have this message ID, skip
    if (inbound.id) {
      const existing = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(inbound.id) as any;
      if (existing) {
        return { message: this.rowToMessage(existing) };
      }
    }

    const msg: ChatMessage = {
      id: msgId,
      channelId: channel.id,
      threadId,
      from,
      to,
      type: finalType,
      content: finalContent,
      timestamp: inbound.timestamp,
      signature: inbound.signature,
      delivery: "delivered",
      deliveredAt: now,
      replyTo: inbound.replyTo,
      metadata: { ...inbound.metadata, ...(type === "encrypted" ? { wasEncrypted: true } : {}) },
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, channelId, threadId, fromName, fromEndpoint, fromPublicKey,
         toName, toEndpoint, toPublicKey, type, content, timestamp, signature, delivery,
         deliveredAt, readAt, replyTo, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id, msg.channelId, msg.threadId,
        msg.from.name, msg.from.endpoint, msg.from.publicKey,
        msg.to.name, msg.to.endpoint, msg.to.publicKey,
        msg.type, msg.content, msg.timestamp, msg.signature, msg.delivery,
        msg.deliveredAt || null, msg.readAt || null, msg.replyTo || null,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
      );

    // Update channel timestamps
    this.db
      .prepare("UPDATE channels SET lastMessageAt = ?, updatedAt = ? WHERE id = ?")
      .run(now, now, channel.id);

    // Notify SSE listeners
    for (const listener of this.sseListeners) {
      try {
        listener(msg);
      } catch { /* ignore */ }
    }

    return { message: msg };
  }

  // ── Quarantine ───────────────────────────────────────────────────────────

  getQuarantine(): QuarantinedMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM quarantine ORDER BY receivedAt DESC")
      .all() as any[];
    return rows.map((r) => this.rowToQuarantined(r));
  }

  async approveQuarantined(quarantineId: string): Promise<ChatMessage> {
    const row = this.db.prepare("SELECT * FROM quarantine WHERE id = ?").get(quarantineId) as any;
    if (!row) throw new NotFoundError(`Quarantined message ${quarantineId} not found`);

    const quarantined = this.rowToQuarantined(row);
    const raw = quarantined.rawMessage;

    // Normalize: ensure "from" is set (may have arrived as "sender")
    const senderIdentity = raw.from || (raw as any).sender;
    if (!senderIdentity) throw new ValidationError("Quarantined message has no sender identity");

    // Add sender to trusted endpoints
    this.addTrustedEndpoint(senderIdentity);

    // Remove from quarantine BEFORE re-processing
    this.db.prepare("DELETE FROM quarantine WHERE id = ?").run(quarantineId);

    // Re-process the message now that sender is trusted
    const normalizedMessage = { ...raw, from: senderIdentity };
    const result = await this.receiveInbound(normalizedMessage);

    if (result.message) return result.message;
    throw new ValidationError("Failed to process quarantined message after approval");
  }

  rejectQuarantined(quarantineId: string): void {
    const row = this.db.prepare("SELECT * FROM quarantine WHERE id = ?").get(quarantineId) as any;
    if (!row) throw new NotFoundError(`Quarantined message ${quarantineId} not found`);
    this.db.prepare("DELETE FROM quarantine WHERE id = ?").run(quarantineId);
  }

  // ── SSE Support ──────────────────────────────────────────────────────────

  addInboxListener(listener: (msg: ChatMessage) => void): () => void {
    this.sseListeners.add(listener);
    return () => this.sseListeners.delete(listener);
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  flush(): void {
    // No-op for SQLite — writes are immediate. Kept for API compatibility.
  }

  get channelCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM channels").get() as any;
    return row.cnt;
  }

  get messageCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as any;
    return row.cnt;
  }

  get quarantineCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM quarantine").get() as any;
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
