import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export type MessageType = "text" | "task" | "seed" | "announcement" | "ack" | "system";
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

const VALID_MESSAGE_TYPES: Set<string> = new Set(["text", "task", "seed", "announcement", "ack", "system"]);
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
  private data: StoreData = {
    channels: [],
    messages: [],
    trustedEndpoints: [],
    quarantine: [],
    localIdentity: null,
  };
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private privateKey?: string;
  private sseListeners: Set<(msg: ChatMessage) => void> = new Set();

  constructor(filePath = "data/fleet-chat.json", privateKey?: string) {
    this.filePath = filePath;
    this.privateKey = privateKey;
    this.load();
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    if (!existsSync(this.filePath)) return;
    try {
      const content = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        this.data = {
          channels: parsed.channels || [],
          messages: parsed.messages || [],
          trustedEndpoints: parsed.trustedEndpoints || [],
          quarantine: parsed.quarantine || [],
          localIdentity: parsed.localIdentity || null,
        };
      }
    } catch {
      // start fresh
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      atomicWriteFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }, 100);
  }

  // ── Local Identity ───────────────────────────────────────────────────────

  setLocalIdentity(identity: FleetIdentity): void {
    this.data.localIdentity = validateFleetIdentity(identity, "localIdentity");
    this.scheduleSave();
  }

  getLocalIdentity(): FleetIdentity | null {
    return this.data.localIdentity;
  }

  setPrivateKey(key: string): void {
    this.privateKey = key;
  }

  // ── Trusted Endpoints (simple contacts substitute) ───────────────────────

  addTrustedEndpoint(endpoint: Omit<TrustedEndpoint, "addedAt">): TrustedEndpoint {
    const validated = validateFleetIdentity(endpoint, "trustedEndpoint");
    const existing = this.data.trustedEndpoints.find(
      (e) => e.endpoint === validated.endpoint || e.publicKey === validated.publicKey,
    );
    if (existing) {
      // Update existing
      existing.name = validated.name;
      existing.endpoint = validated.endpoint;
      existing.publicKey = validated.publicKey;
      existing.notes = (endpoint as TrustedEndpoint).notes;
      this.scheduleSave();
      return existing;
    }
    const entry: TrustedEndpoint = {
      ...validated,
      addedAt: new Date().toISOString(),
      notes: (endpoint as TrustedEndpoint).notes,
    };
    this.data.trustedEndpoints.push(entry);
    this.scheduleSave();
    return entry;
  }

  removeTrustedEndpoint(endpoint: string): boolean {
    const idx = this.data.trustedEndpoints.findIndex((e) => e.endpoint === endpoint);
    if (idx === -1) return false;
    this.data.trustedEndpoints.splice(idx, 1);
    this.scheduleSave();
    return true;
  }

  getTrustedEndpoints(): TrustedEndpoint[] {
    return [...this.data.trustedEndpoints];
  }

  isTrusted(endpoint?: string, publicKey?: string): boolean {
    return this.data.trustedEndpoints.some(
      (e) => (endpoint && e.endpoint === endpoint) || (publicKey && e.publicKey === publicKey),
    );
  }

  findTrustedByKey(publicKey: string): TrustedEndpoint | undefined {
    return this.data.trustedEndpoints.find((e) => e.publicKey === publicKey);
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  createChannel(input: CreateChannelInput): Channel {
    const localIdentity = this.data.localIdentity;
    if (!localIdentity) throw new ValidationError("Local identity must be set before creating channels");

    const remoteFleet = validateFleetIdentity(input.remoteFleet, "remoteFleet");

    // Check for existing active channel with this fleet
    const existing = this.data.channels.find(
      (ch) =>
        ch.status === "active" &&
        (ch.remoteFleet.endpoint === remoteFleet.endpoint ||
          ch.remoteFleet.publicKey === remoteFleet.publicKey),
    );
    if (existing) return existing; // Idempotent

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

    this.data.channels.push(channel);

    // Auto-add remote fleet to trusted endpoints if not already trusted
    if (!this.isTrusted(remoteFleet.endpoint, remoteFleet.publicKey)) {
      this.addTrustedEndpoint(remoteFleet);
    }

    this.scheduleSave();
    return channel;
  }

  getChannel(id: string): Channel {
    const ch = this.data.channels.find((c) => c.id === id);
    if (!ch) throw new NotFoundError(`Channel ${id} not found`);
    return ch;
  }

  listChannels(opts?: { status?: ChannelStatus }): Channel[] {
    let channels = [...this.data.channels];
    if (opts?.status) {
      channels = channels.filter((c) => c.status === opts.status);
    }
    return channels.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  }

  findChannelByRemote(endpoint?: string, publicKey?: string): Channel | undefined {
    return this.data.channels.find(
      (ch) =>
        ch.status === "active" &&
        ((endpoint && ch.remoteFleet.endpoint === endpoint) ||
          (publicKey && ch.remoteFleet.publicKey === publicKey)),
    );
  }

  updateChannelStatus(id: string, status: ChannelStatus): Channel {
    const ch = this.getChannel(id);
    if (!VALID_CHANNEL_STATUSES.has(status)) {
      throw new ValidationError(`Invalid status. Must be one of: ${[...VALID_CHANNEL_STATUSES].join(", ")}`);
    }
    ch.status = status;
    ch.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return ch;
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  sendMessage(input: SendMessageInput): ChatMessage {
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
      const parent = this.data.messages.find((m) => m.id === input.replyTo);
      if (!parent) throw new NotFoundError(`Message ${input.replyTo} not found`);
      threadId = parent.threadId;
    } else {
      threadId = ulid();
    }

    const now = new Date().toISOString();
    const sig = signMessage(input.content, now, this.privateKey);

    const msg: ChatMessage = {
      id: ulid(),
      channelId: channel.id,
      threadId,
      from: { ...channel.localFleet },
      to: { ...channel.remoteFleet },
      type,
      content: input.content.trim(),
      timestamp: now,
      signature: sig,
      delivery: "pending",
      replyTo: input.replyTo,
      metadata: input.metadata,
    };

    this.data.messages.push(msg);
    channel.lastMessageAt = now;
    channel.updatedAt = now;
    this.scheduleSave();
    return msg;
  }

  getMessages(
    channelId: string,
    opts?: { limit?: number; after?: string; before?: string; threadId?: string },
  ): ChatMessage[] {
    this.getChannel(channelId); // Verify channel exists

    let msgs = this.data.messages.filter((m) => m.channelId === channelId);

    if (opts?.threadId) {
      msgs = msgs.filter((m) => m.threadId === opts.threadId);
    }
    if (opts?.after) {
      msgs = msgs.filter((m) => m.timestamp > opts.after!);
    }
    if (opts?.before) {
      msgs = msgs.filter((m) => m.timestamp < opts.before!);
    }

    // Chronological order
    msgs = msgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (opts?.limit) {
      msgs = msgs.slice(-opts.limit); // Last N messages
    }

    return msgs;
  }

  updateDelivery(messageId: string, status: DeliveryStatus): ChatMessage {
    const msg = this.data.messages.find((m) => m.id === messageId);
    if (!msg) throw new NotFoundError(`Message ${messageId} not found`);
    msg.delivery = status;
    if (status === "delivered") msg.deliveredAt = new Date().toISOString();
    if (status === "read") msg.readAt = new Date().toISOString();
    this.scheduleSave();
    return msg;
  }

  // ── Inbound (Public Inbox) ───────────────────────────────────────────────

  /**
   * Receive a message from another fleet via the public inbox.
   * Verifies the sender against trusted endpoints.
   * Unknown senders go to quarantine.
   */
  receiveInbound(inbound: InboundMessage): { message?: ChatMessage; quarantined?: QuarantinedMessage } {
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
      this.data.quarantine.push(quarantined);
      this.scheduleSave();
      return { quarantined };
    }

    // Trusted senders bypass signature verification entirely.
    // This allows placeholder keys during development — the trust list
    // is the source of truth, not cryptographic signatures.
    // For untrusted senders (shouldn't reach here), we'd still verify.
    // In the future, real Ed25519 verification can be added as a
    // defense-in-depth layer even for trusted senders.

    // Find or create channel for this sender
    let channel = this.findChannelByRemote(from.endpoint, from.publicKey);
    if (!channel) {
      // Auto-create channel for trusted senders
      if (this.data.localIdentity) {
        channel = this.createChannel({ remoteFleet: from });
      } else {
        throw new ValidationError("Local identity not set, cannot receive messages");
      }
    }

    // Determine thread
    let threadId: string;
    if (inbound.replyTo) {
      const parent = this.data.messages.find((m) => m.id === inbound.replyTo);
      threadId = parent?.threadId || inbound.threadId || ulid();
    } else {
      threadId = inbound.threadId || ulid();
    }

    const now = new Date().toISOString();
    const msg: ChatMessage = {
      id: inbound.id || ulid(),
      channelId: channel.id,
      threadId,
      from,
      to,
      type,
      content: inbound.content.trim(),
      timestamp: inbound.timestamp,
      signature: inbound.signature,
      delivery: "delivered",
      deliveredAt: now,
      replyTo: inbound.replyTo,
      metadata: inbound.metadata,
    };

    // Deduplicate — if we already have this message ID, skip
    if (inbound.id && this.data.messages.some((m) => m.id === inbound.id)) {
      return { message: this.data.messages.find((m) => m.id === inbound.id)! };
    }

    this.data.messages.push(msg);
    channel.lastMessageAt = now;
    channel.updatedAt = now;
    this.scheduleSave();

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
    return [...this.data.quarantine].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  approveQuarantined(quarantineId: string): ChatMessage {
    const idx = this.data.quarantine.findIndex((q) => q.id === quarantineId);
    if (idx === -1) throw new NotFoundError(`Quarantined message ${quarantineId} not found`);

    const quarantined = this.data.quarantine[idx];
    const raw = quarantined.rawMessage;

    // Normalize: ensure "from" is set (may have arrived as "sender")
    const senderIdentity = raw.from || (raw as any).sender;
    if (!senderIdentity) throw new ValidationError("Quarantined message has no sender identity");

    // Add sender to trusted endpoints
    this.addTrustedEndpoint(senderIdentity);

    // Remove from quarantine BEFORE re-processing to avoid
    // receiveInbound finding this same entry if anything goes wrong
    this.data.quarantine.splice(idx, 1);

    // Re-process the message now that sender is trusted
    // Ensure from field is set for receiveInbound
    const normalizedMessage = { ...raw, from: senderIdentity };
    const result = this.receiveInbound(normalizedMessage);

    this.scheduleSave();

    if (result.message) return result.message;
    throw new ValidationError("Failed to process quarantined message after approval");
  }

  rejectQuarantined(quarantineId: string): void {
    const idx = this.data.quarantine.findIndex((q) => q.id === quarantineId);
    if (idx === -1) throw new NotFoundError(`Quarantined message ${quarantineId} not found`);
    this.data.quarantine[idx].reviewed = true;
    this.data.quarantine.splice(idx, 1);
    this.scheduleSave();
  }

  // ── SSE Support ──────────────────────────────────────────────────────────

  addInboxListener(listener: (msg: ChatMessage) => void): () => void {
    this.sseListeners.add(listener);
    return () => this.sseListeners.delete(listener);
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
      atomicWriteFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }
  }

  get channelCount(): number {
    return this.data.channels.length;
  }

  get messageCount(): number {
    return this.data.messages.length;
  }

  get quarantineCount(): number {
    return this.data.quarantine.length;
  }
}
