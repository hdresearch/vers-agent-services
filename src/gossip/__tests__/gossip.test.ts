import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GossipStore } from "../store.js";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";

const TEST_FILE = "data/test-gossip.json";

function cleanup() {
  for (const f of [TEST_FILE, TEST_FILE + ".tmp"]) {
    try { unlinkSync(f); } catch {}
  }
}

describe("GossipStore", () => {
  let store: GossipStore;

  beforeEach(() => {
    cleanup();
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    store = new GossipStore(TEST_FILE);
  });

  afterEach(() => cleanup());

  describe("send", () => {
    it("sends a message and returns it with id/thread", () => {
      const msg = store.send({
        from: "sentinel",
        to: "quartermaster",
        type: "request",
        subject: "Need status",
        body: "What is current dispatch queue?",
      });

      expect(msg.id).toBeTruthy();
      expect(msg.threadId).toBeTruthy();
      expect(msg.from).toBe("sentinel");
      expect(msg.to).toBe("quartermaster");
      expect(msg.type).toBe("request");
      expect(msg.priority).toBe("normal");
      expect(msg.createdAt).toBeTruthy();
    });

    it("validates required fields", () => {
      expect(() => store.send({ from: "", to: "x", type: "inform", subject: "s", body: "b" }))
        .toThrow("'from' is required");
      expect(() => store.send({ from: "a", to: "", type: "inform", subject: "s", body: "b" }))
        .toThrow("'to' is required");
      expect(() => store.send({ from: "a", to: "b", type: "bad" as any, subject: "s", body: "b" }))
        .toThrow("Invalid type");
    });

    it("validates priority", () => {
      expect(() => store.send({ from: "a", to: "b", type: "inform", subject: "s", body: "b", priority: "mega" as any }))
        .toThrow("Invalid priority");
    });
  });

  describe("reply threading", () => {
    it("replies share the parent threadId", () => {
      const orig = store.send({
        from: "sentinel",
        to: "scribe",
        type: "question",
        subject: "Docs outdated?",
        body: "When was the last update?",
      });

      const reply = store.send({
        from: "scribe",
        to: "sentinel",
        type: "reply",
        subject: "Re: Docs outdated?",
        body: "Updated 2 hours ago",
        replyTo: orig.id,
      });

      expect(reply.threadId).toBe(orig.threadId);
      expect(reply.replyTo).toBe(orig.id);
    });

    it("errors on reply to nonexistent message", () => {
      expect(() =>
        store.send({
          from: "a",
          to: "b",
          type: "reply",
          subject: "re",
          body: "yo",
          replyTo: "NONEXISTENT",
        }),
      ).toThrow("not found");
    });
  });

  describe("inbox", () => {
    it("returns messages addressed to agent", () => {
      store.send({ from: "a", to: "b", type: "inform", subject: "s1", body: "b1" });
      store.send({ from: "a", to: "c", type: "inform", subject: "s2", body: "b2" });
      store.send({ from: "c", to: "b", type: "inform", subject: "s3", body: "b3" });

      const inbox = store.getInbox("b");
      expect(inbox).toHaveLength(2);
      expect(inbox.every((m) => m.to === "b")).toBe(true);
    });

    it("includes broadcasts in inbox", () => {
      store.broadcast({ from: "orchestrator", type: "alert", subject: "Deploy", body: "Deploying v2" });
      store.send({ from: "a", to: "b", type: "inform", subject: "s", body: "b" });

      const inbox = store.getInbox("b");
      expect(inbox).toHaveLength(2);
    });

    it("filters unread only", () => {
      const msg = store.send({ from: "a", to: "b", type: "inform", subject: "s", body: "b" });
      store.send({ from: "c", to: "b", type: "inform", subject: "s2", body: "b2" });
      store.markRead(msg.id);

      const unread = store.getInbox("b", { unreadOnly: true });
      expect(unread).toHaveLength(1);
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        store.send({ from: "a", to: "b", type: "inform", subject: `s${i}`, body: `b${i}` });
      }
      const limited = store.getInbox("b", { limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });

  describe("threads", () => {
    it("returns all messages in a thread chronologically", () => {
      const m1 = store.send({ from: "a", to: "b", type: "question", subject: "Q", body: "question" });
      store.send({ from: "b", to: "a", type: "reply", subject: "Re: Q", body: "answer", replyTo: m1.id });

      const thread = store.getThread(m1.threadId);
      expect(thread).toHaveLength(2);
      expect(thread[0].from).toBe("a");
      expect(thread[1].from).toBe("b");
    });

    it("errors on nonexistent thread", () => {
      expect(() => store.getThread("NONEXISTENT")).toThrow("not found");
    });
  });

  describe("broadcast", () => {
    it("sends to '*'", () => {
      const msg = store.broadcast({ from: "orchestrator", type: "inform", subject: "Update", body: "All good" });
      expect(msg.to).toBe("*");
    });
  });

  describe("activity", () => {
    it("returns summary for orchestrator", () => {
      store.send({ from: "sentinel", to: "quartermaster", type: "alert", subject: "Down", body: "Service X down", priority: "urgent" });
      store.send({ from: "scribe", to: "auditor", type: "inform", subject: "Report", body: "Done" });
      store.broadcast({ from: "orchestrator", type: "inform", subject: "Status", body: "All good" });

      const activity = store.getActivity();
      expect(activity.totalMessages).toBe(3);
      expect(activity.urgentUnread).toHaveLength(1);
      expect(activity.recentThreads.length).toBeGreaterThan(0);
      expect(activity.topSenders.length).toBeGreaterThan(0);
    });
  });

  describe("persistence", () => {
    it("survives reload", async () => {
      store.send({ from: "a", to: "b", type: "inform", subject: "s", body: "persist me" });

      // Force save (debounced at 100ms)
      await new Promise((r) => setTimeout(r, 200));

      const store2 = new GossipStore(TEST_FILE);
      expect(store2.size).toBe(1);
    });
  });
});
