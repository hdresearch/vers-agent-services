import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { ValidationError, NotFoundError } from "../errors.js";

export type MessageType = "request" | "inform" | "alert" | "question" | "reply" | "ack";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface Message {
  id: string;
  threadId: string;
  from: string;
  to: string | "*"; // "*" = broadcast
  type: MessageType;
  subject: string;
  body: string;
  priority: Priority;
  createdAt: string;
  readAt?: string;
  replyTo?: string;
}

export interface SendInput {
  from: string;
  to: string;
  type: MessageType;
  subject: string;
  body: string;
  priority?: Priority;
  replyTo?: string;
}

export interface BroadcastInput {
  from: string;
  type: MessageType;
  subject: string;
  body: string;
  priority?: Priority;
}

export interface ThreadSummary {
  threadId: string;
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessage: string; // ISO timestamp
}

export interface ActivitySummary {
  totalMessages: number;
  unreadByAgent: Record<string, number>;
  recentThreads: ThreadSummary[];
  topSenders: { agent: string; count: number }[];
  urgentUnread: Message[];
}

const VALID_TYPES: Set<string> = new Set(["request", "inform", "alert", "question", "reply", "ack"]);
const VALID_PRIORITIES: Set<string> = new Set(["low", "normal", "high", "urgent"]);

export class GossipStore {
  private messages: Message[] = [];
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private maxMessages: number;

  constructor(filePath = "data/gossip.json", maxMessages = 10000) {
    this.filePath = filePath;
    this.maxMessages = maxMessages;
    this.load();
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    if (!existsSync(this.filePath)) return;
    try {
      const content = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        this.messages = data;
      }
    } catch {
      // start fresh
    }
    // Prune to max on load
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  private save(): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(this.messages, null, 2));
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.save();
    }, 100);
  }

  private prune(): void {
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  send(input: SendInput): Message {
    if (!input.from?.trim()) throw new ValidationError("'from' is required");
    if (!input.subject?.trim()) throw new ValidationError("'subject' is required");
    if (!input.body?.trim()) throw new ValidationError("'body' is required");
    if (!VALID_TYPES.has(input.type)) {
      throw new ValidationError(`Invalid type. Must be one of: ${[...VALID_TYPES].join(", ")}`);
    }
    if (input.priority && !VALID_PRIORITIES.has(input.priority)) {
      throw new ValidationError(`Invalid priority. Must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
    }

    // Determine thread: if replying, use parent's thread; otherwise new thread
    let threadId: string;
    if (input.replyTo) {
      const parent = this.messages.find((m) => m.id === input.replyTo);
      if (!parent) throw new NotFoundError(`Message ${input.replyTo} not found`);
      threadId = parent.threadId;
      // Auto-resolve 'to' for replies: reply goes to original sender
      if (!input.to?.trim() && parent.from) {
        input.to = parent.from;
      }
    } else {
      threadId = ulid();
    }

    // Validate 'to' after replyTo auto-resolve so replies can omit it
    if (!input.to?.trim()) throw new ValidationError("'to' is required");

    const msg: Message = {
      id: ulid(),
      threadId,
      from: input.from.trim(),
      to: input.to.trim(),
      type: input.type,
      subject: input.subject.trim(),
      body: input.body.trim(),
      priority: input.priority || "normal",
      createdAt: new Date().toISOString(),
      replyTo: input.replyTo,
    };

    this.messages.push(msg);
    this.prune();
    this.scheduleSave();
    return msg;
  }

  broadcast(input: BroadcastInput): Message {
    return this.send({
      ...input,
      to: "*",
    });
  }

  getInbox(agent: string, opts?: { unreadOnly?: boolean; limit?: number; offset?: number }): { messages: Message[]; total: number } {
    let msgs = this.messages.filter(
      (m) => m.to === agent || m.to === "*"
    );

    if (opts?.unreadOnly) {
      msgs = msgs.filter((m) => !m.readAt);
    }

    // Newest first
    msgs = msgs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const total = msgs.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    msgs = msgs.slice(offset, offset + limit);

    return { messages: msgs, total };
  }

  getThread(threadId: string): Message[] {
    const msgs = this.messages.filter((m) => m.threadId === threadId);
    if (msgs.length === 0) throw new NotFoundError(`Thread ${threadId} not found`);
    return msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markRead(messageId: string): Message {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg) throw new NotFoundError(`Message ${messageId} not found`);
    msg.readAt = new Date().toISOString();
    this.scheduleSave();
    return msg;
  }

  getActivity(): ActivitySummary {
    // Unread by agent
    const unreadByAgent: Record<string, number> = {};
    for (const m of this.messages) {
      if (!m.readAt && m.to !== "*") {
        unreadByAgent[m.to] = (unreadByAgent[m.to] || 0) + 1;
      }
    }

    // Thread summaries (last 10)
    const threadMap = new Map<string, Message[]>();
    for (const m of this.messages) {
      if (!threadMap.has(m.threadId)) threadMap.set(m.threadId, []);
      threadMap.get(m.threadId)!.push(m);
    }

    const threads: ThreadSummary[] = [...threadMap.entries()]
      .map(([threadId, msgs]) => ({
        threadId,
        subject: msgs[0].subject,
        participants: [...new Set(msgs.map((m) => m.from))],
        messageCount: msgs.length,
        lastMessage: msgs[msgs.length - 1].createdAt,
      }))
      .sort((a, b) => b.lastMessage.localeCompare(a.lastMessage))
      .slice(0, 10);

    // Top senders
    const senderCounts = new Map<string, number>();
    for (const m of this.messages) {
      senderCounts.set(m.from, (senderCounts.get(m.from) || 0) + 1);
    }
    const topSenders = [...senderCounts.entries()]
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Urgent unread
    const urgentUnread = this.messages.filter(
      (m) => m.priority === "urgent" && !m.readAt
    );

    return {
      totalMessages: this.messages.length,
      unreadByAgent,
      recentThreads: threads,
      topSenders,
      urgentUnread,
    };
  }

  /** Flush to disk immediately. Always writes, regardless of pending timer. Call on shutdown. */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.save();
  }

  get size(): number {
    return this.messages.length;
  }
}
