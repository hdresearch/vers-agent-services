import { describe, it, expect, beforeEach } from "vitest";
import {
  FleetChatStore,
  generateKeyPair,
  signMessage,
  verifySignature,
  type FleetIdentity,
} from "../store.js";

const LOCAL_FLEET: FleetIdentity = {
  name: "noah-fleet",
  endpoint: "https://noah.vm.vers.sh:3000",
  publicKey: "pk-noah-test",
};

const REMOTE_FLEET: FleetIdentity = {
  name: "ty-fleet",
  endpoint: "https://ty.vm.vers.sh:3000",
  publicKey: "pk-ty-test",
};

const UNKNOWN_FLEET: FleetIdentity = {
  name: "stranger-fleet",
  endpoint: "https://stranger.vm.vers.sh:3000",
  publicKey: "pk-stranger-test",
};

function makeStore(): FleetChatStore {
  // Use unique temp path per test to avoid collisions
  const store = new FleetChatStore(`/tmp/fleet-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store.setLocalIdentity(LOCAL_FLEET);
  return store;
}

describe("FleetChatStore", () => {
  // ── Identity ─────────────────────────────────────────────────────────
  describe("identity", () => {
    it("sets and gets local identity", () => {
      const store = makeStore();
      expect(store.getLocalIdentity()).toEqual(LOCAL_FLEET);
    });

    it("rejects invalid identity", () => {
      const store = makeStore();
      expect(() => store.setLocalIdentity({ name: "", endpoint: "", publicKey: "" } as any)).toThrow();
    });
  });

  // ── Trusted Endpoints ────────────────────────────────────────────────
  describe("trusted endpoints", () => {
    it("adds and lists trusted endpoints", () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);
      const endpoints = store.getTrustedEndpoints();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].name).toBe("ty-fleet");
    });

    it("isTrusted checks by endpoint or publicKey", () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);
      expect(store.isTrusted(REMOTE_FLEET.endpoint)).toBe(true);
      expect(store.isTrusted(undefined, REMOTE_FLEET.publicKey)).toBe(true);
      expect(store.isTrusted("https://unknown.com")).toBe(false);
    });

    it("updates existing endpoint on re-add", () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);
      store.addTrustedEndpoint({ ...REMOTE_FLEET, name: "ty-updated" });
      const endpoints = store.getTrustedEndpoints();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].name).toBe("ty-updated");
    });

    it("removes trusted endpoint", () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);
      expect(store.removeTrustedEndpoint(REMOTE_FLEET.endpoint)).toBe(true);
      expect(store.getTrustedEndpoints()).toHaveLength(0);
    });
  });

  // ── Channels ─────────────────────────────────────────────────────────
  describe("channels", () => {
    it("creates a channel", () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      expect(ch.id).toBeTruthy();
      expect(ch.localFleet.name).toBe("noah-fleet");
      expect(ch.remoteFleet.name).toBe("ty-fleet");
      expect(ch.status).toBe("active");
    });

    it("returns existing channel for same remote fleet (idempotent)", () => {
      const store = makeStore();
      const ch1 = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const ch2 = store.createChannel({ remoteFleet: REMOTE_FLEET });
      expect(ch1.id).toBe(ch2.id);
    });

    it("auto-adds remote fleet to trusted endpoints", () => {
      const store = makeStore();
      store.createChannel({ remoteFleet: REMOTE_FLEET });
      expect(store.isTrusted(REMOTE_FLEET.endpoint)).toBe(true);
    });

    it("lists channels", () => {
      const store = makeStore();
      store.createChannel({ remoteFleet: REMOTE_FLEET });
      const channels = store.listChannels();
      expect(channels).toHaveLength(1);
    });

    it("gets channel by id", () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const fetched = store.getChannel(ch.id);
      expect(fetched.id).toBe(ch.id);
    });

    it("throws on unknown channel", () => {
      const store = makeStore();
      expect(() => store.getChannel("nonexistent")).toThrow("not found");
    });

    it("updates channel status", () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const updated = store.updateChannelStatus(ch.id, "archived");
      expect(updated.status).toBe("archived");
    });

    it("finds channel by remote endpoint", () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const found = store.findChannelByRemote(REMOTE_FLEET.endpoint);
      expect(found?.id).toBe(ch.id);
    });

    it("requires local identity before creating channels", () => {
      const store = new FleetChatStore(`/tmp/fleet-chat-test-${Date.now()}.db`);
      expect(() => store.createChannel({ remoteFleet: REMOTE_FLEET })).toThrow("Local identity");
    });
  });

  // ── Messages ─────────────────────────────────────────────────────────
  describe("messages", () => {
    it("sends a message", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const msg = await store.sendMessage({ channelId: ch.id, content: "Hello fleet!" });
      expect(msg.id).toBeTruthy();
      expect(msg.content).toBe("Hello fleet!");
      expect(msg.type).toBe("text");
      expect(msg.delivery).toBe("pending");
      expect(msg.signature).toBeTruthy();
    });

    it("supports different message types", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const msg = await store.sendMessage({ channelId: ch.id, content: "task data", type: "task" });
      expect(msg.type).toBe("task");
    });

    it("rejects invalid message type", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      await expect(store.sendMessage({ channelId: ch.id, content: "hi", type: "invalid" as any })).rejects.toThrow();
    });

    it("rejects empty content", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      await expect(store.sendMessage({ channelId: ch.id, content: "" })).rejects.toThrow("content is required");
    });

    it("creates threads via replyTo", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const msg1 = await store.sendMessage({ channelId: ch.id, content: "first" });
      const msg2 = await store.sendMessage({ channelId: ch.id, content: "reply", replyTo: msg1.id });
      expect(msg2.threadId).toBe(msg1.threadId);
    });

    it("gets messages with filtering", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      await store.sendMessage({ channelId: ch.id, content: "msg 1" });
      await store.sendMessage({ channelId: ch.id, content: "msg 2" });
      await store.sendMessage({ channelId: ch.id, content: "msg 3" });

      const all = store.getMessages(ch.id);
      expect(all).toHaveLength(3);

      const limited = store.getMessages(ch.id, { limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited[1].content).toBe("msg 3"); // Last 2
    });

    it("filters by threadId", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const msg1 = await store.sendMessage({ channelId: ch.id, content: "thread 1" });
      await store.sendMessage({ channelId: ch.id, content: "standalone" });
      await store.sendMessage({ channelId: ch.id, content: "reply to 1", replyTo: msg1.id });

      const threaded = store.getMessages(ch.id, { threadId: msg1.threadId });
      expect(threaded).toHaveLength(2);
    });

    it("updates delivery status", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      const msg = await store.sendMessage({ channelId: ch.id, content: "hello" });
      const updated = store.updateDelivery(msg.id, "delivered");
      expect(updated.delivery).toBe("delivered");
      expect(updated.deliveredAt).toBeTruthy();
    });

    it("rejects messages on closed channel", async () => {
      const store = makeStore();
      const ch = store.createChannel({ remoteFleet: REMOTE_FLEET });
      store.updateChannelStatus(ch.id, "closed");
      await expect(store.sendMessage({ channelId: ch.id, content: "hello" })).rejects.toThrow("closed");
    });
  });

  // ── Inbound (Public Inbox) ───────────────────────────────────────────
  describe("inbound", () => {
    it("receives message from trusted sender", async () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);

      const timestamp = new Date().toISOString();
      const sig = signMessage("hello from ty", timestamp);

      const result = await store.receiveInbound({
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "hello from ty",
        timestamp,
        signature: sig,
      });

      expect(result.message).toBeTruthy();
      expect(result.message!.content).toBe("hello from ty");
      expect(result.message!.delivery).toBe("delivered");
    });

    it("quarantines message from unknown sender", async () => {
      const store = makeStore();

      const timestamp = new Date().toISOString();
      const sig = signMessage("hello from stranger", timestamp);

      const result = await store.receiveInbound({
        from: UNKNOWN_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "hello from stranger",
        timestamp,
        signature: sig,
      });

      expect(result.quarantined).toBeTruthy();
      expect(result.quarantined!.reason).toContain("Unknown sender");
      expect(store.quarantineCount).toBe(1);
    });

    it("deduplicates by message ID", async () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);

      const timestamp = new Date().toISOString();
      const sig = signMessage("hello", timestamp);
      const inbound = {
        id: "DEDUP001",
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text" as const,
        content: "hello",
        timestamp,
        signature: sig,
      };

      await store.receiveInbound(inbound);
      await store.receiveInbound(inbound); // Duplicate
      expect(store.messageCount).toBe(1);
    });

    it("auto-creates channel for trusted sender", async () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);

      const timestamp = new Date().toISOString();
      const sig = signMessage("hi", timestamp);

      await store.receiveInbound({
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "hi",
        timestamp,
        signature: sig,
      });

      expect(store.channelCount).toBe(1);
    });

    it("rejects messages without signature", async () => {
      const store = makeStore();
      await expect(
        store.receiveInbound({
          from: REMOTE_FLEET,
          to: LOCAL_FLEET,
          type: "text",
          content: "hi",
          timestamp: new Date().toISOString(),
          signature: "",
        }),
      ).rejects.toThrow("signature is required");
    });
  });

  // ── Quarantine ───────────────────────────────────────────────────────
  describe("quarantine", () => {
    it("approves quarantined message — adds sender to trusted", async () => {
      const store = makeStore();

      const timestamp = new Date().toISOString();
      const sig = signMessage("let me in", timestamp);

      const result = await store.receiveInbound({
        from: UNKNOWN_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "let me in",
        timestamp,
        signature: sig,
      });

      expect(result.quarantined).toBeTruthy();

      const msg = await store.approveQuarantined(result.quarantined!.id);
      expect(msg.content).toBe("let me in");
      expect(store.isTrusted(UNKNOWN_FLEET.endpoint)).toBe(true);
      expect(store.quarantineCount).toBe(0);
    });

    it("rejects quarantined message", async () => {
      const store = makeStore();

      const timestamp = new Date().toISOString();
      const sig = signMessage("spam", timestamp);

      const result = await store.receiveInbound({
        from: UNKNOWN_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "spam",
        timestamp,
        signature: sig,
      });

      store.rejectQuarantined(result.quarantined!.id);
      expect(store.quarantineCount).toBe(0);
    });
  });

  // ── SSE Listeners ────────────────────────────────────────────────────
  describe("SSE listeners", () => {
    it("notifies listeners on inbound message", async () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);

      const received: any[] = [];
      const remove = store.addInboxListener((msg) => received.push(msg));

      const timestamp = new Date().toISOString();
      const sig = signMessage("live!", timestamp);

      await store.receiveInbound({
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "live!",
        timestamp,
        signature: sig,
      });

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("live!");

      remove();

      // After removing, no more notifications
      const timestamp2 = new Date().toISOString();
      const sig2 = signMessage("second", timestamp2);
      await store.receiveInbound({
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "second",
        timestamp: timestamp2,
        signature: sig2,
      });

      expect(received).toHaveLength(1);
    });
  });

  // ── Bug fixes: trusted bypass, approve flow, sender alias ─────────
  describe("trusted sender bypass (Bug #2 fix)", () => {
    it("trusted sender with placeholder key bypasses sig verification", async () => {
      const store = makeStore();
      const joseph: FleetIdentity = {
        name: "joseph",
        endpoint: "https://joseph.vm.vers.sh:3000",
        publicKey: "joseph-placeholder-key",
      };
      store.addTrustedEndpoint(joseph);

      // Send with a garbage signature — should still go through (Phase 1 tolerance)
      const result = await store.receiveInbound({
        from: joseph,
        to: LOCAL_FLEET,
        type: "text",
        content: "hey noah, it's joseph",
        timestamp: new Date().toISOString(),
        signature: "totally-not-a-real-signature",
      });

      expect(result.message).toBeTruthy();
      expect(result.quarantined).toBeUndefined();
      expect(result.message!.content).toBe("hey noah, it's joseph");
      expect(result.message!.delivery).toBe("delivered");
    });

    it("untrusted sender with bad sig is still quarantined", async () => {
      const store = makeStore();
      const stranger: FleetIdentity = {
        name: "stranger",
        endpoint: "https://stranger.vm.vers.sh:3000",
        publicKey: "stranger-key",
      };

      const result = await store.receiveInbound({
        from: stranger,
        to: LOCAL_FLEET,
        type: "text",
        content: "let me in",
        timestamp: new Date().toISOString(),
        signature: "bad-sig",
      });

      expect(result.quarantined).toBeTruthy();
      expect(result.message).toBeUndefined();
    });
  });

  describe("quarantine approve → channel creation (Bug #1 fix)", () => {
    it("approving quarantined message creates channel and adds message", async () => {
      const store = makeStore();
      const newFleet: FleetIdentity = {
        name: "new-friend",
        endpoint: "https://new-friend.vm.vers.sh:3000",
        publicKey: "new-friend-placeholder-key",
      };

      // Message arrives from unknown sender → quarantined
      const result = await store.receiveInbound({
        from: newFleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "hey, want to connect?",
        timestamp: new Date().toISOString(),
        signature: "some-sig",
      });
      expect(result.quarantined).toBeTruthy();
      expect(store.quarantineCount).toBe(1);
      expect(store.channelCount).toBe(0);

      // Approve it
      const msg = await store.approveQuarantined(result.quarantined!.id);

      // Message should be in a channel now
      expect(msg.content).toBe("hey, want to connect?");
      expect(msg.channelId).toBeTruthy();
      expect(store.channelCount).toBe(1);
      expect(store.quarantineCount).toBe(0);
      expect(store.messageCount).toBe(1);

      // Sender should be trusted
      expect(store.isTrusted(newFleet.endpoint, newFleet.publicKey)).toBe(true);

      // Channel messages should include the approved message
      const messages = store.getMessages(msg.channelId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("hey, want to connect?");
    });

    it("approving multiple quarantined messages from same sender reuses channel", async () => {
      const store = makeStore();
      const fleet: FleetIdentity = {
        name: "multi-msg",
        endpoint: "https://multi.vm.vers.sh:3000",
        publicKey: "multi-placeholder-key",
      };

      const r1 = await store.receiveInbound({
        from: fleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "message 1",
        timestamp: new Date().toISOString(),
        signature: "sig1",
      });
      const r2 = await store.receiveInbound({
        from: fleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "message 2",
        timestamp: new Date().toISOString(),
        signature: "sig2",
      });

      expect(store.quarantineCount).toBe(2);

      const msg1 = await store.approveQuarantined(r1.quarantined!.id);
      const msg2 = await store.approveQuarantined(r2.quarantined!.id);

      expect(msg1.channelId).toBe(msg2.channelId);
      expect(store.channelCount).toBe(1);
      expect(store.messageCount).toBe(2);
      expect(store.quarantineCount).toBe(0);
    });
  });

  describe("message format flexibility (Bug #3 fix)", () => {
    it("accepts 'sender' field as alias for 'from'", async () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);

      const timestamp = new Date().toISOString();
      const result = await store.receiveInbound({
        sender: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "sent with sender field",
        timestamp,
        signature: "any-sig",
      } as any);

      expect(result.message).toBeTruthy();
      expect(result.message!.content).toBe("sent with sender field");
    });

    it("prefers 'from' over 'sender' when both present", async () => {
      const store = makeStore();
      store.addTrustedEndpoint(REMOTE_FLEET);

      const otherFleet = { ...REMOTE_FLEET, name: "other-name" };
      const timestamp = new Date().toISOString();
      const result = await store.receiveInbound({
        from: REMOTE_FLEET,
        sender: otherFleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "both fields",
        timestamp,
        signature: "any-sig",
      } as any);

      expect(result.message).toBeTruthy();
      expect(result.message!.from.name).toBe("ty-fleet");
    });

    it("rejects message with neither 'from' nor 'sender'", async () => {
      const store = makeStore();
      await expect(
        store.receiveInbound({
          to: LOCAL_FLEET,
          type: "text",
          content: "no sender",
          timestamp: new Date().toISOString(),
          signature: "sig",
        } as any),
      ).rejects.toThrow("from must be an object");
    });
  });

  // ── Signature Verification (new crypto) ──────────────────────────────
  describe("signature verification on inbound", () => {
    it("quarantines trusted sender with invalid Ed25519 signature", async () => {
      const { execSync } = await import("node:child_process");
      const { readFileSync } = await import("node:fs");
      const { signContent } = await import("../crypto.js");

      // Generate a key pair for the test
      const keyPath = `/tmp/fleet-sig-test-${Date.now()}`;
      execSync(`ssh-keygen -t ed25519 -f ${keyPath} -N "" -C "sig-test" -q`);
      const pubKey = readFileSync(`${keyPath}.pub`, "utf-8").trim();

      const store = makeStore();
      const trustedFleet: FleetIdentity = {
        name: "sig-test-fleet",
        endpoint: "https://sig-test.vm.vers.sh:3000",
        publicKey: pubKey,
      };
      store.addTrustedEndpoint(trustedFleet);

      // Sign content with the key
      const content = "verified message";
      const sig = await signContent(content, keyPath);

      // Valid signature should work
      const result = await store.receiveInbound({
        from: trustedFleet,
        to: LOCAL_FLEET,
        type: "text",
        content,
        timestamp: new Date().toISOString(),
        signature: sig,
      });
      expect(result.message).toBeTruthy();
      expect(result.message!.content).toBe("verified message");

      // Invalid Ed25519 sig (64 bytes but wrong) should be quarantined
      const fakeSig = Buffer.alloc(64, 0).toString("base64");
      const result2 = await store.receiveInbound({
        from: trustedFleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "tampered",
        timestamp: new Date().toISOString(),
        signature: fakeSig,
      });
      expect(result2.quarantined).toBeTruthy();
      expect(result2.quarantined!.reason).toContain("Invalid Ed25519 signature");

      execSync(`rm -f ${keyPath} ${keyPath}.pub`);
    });

    it("with requireSignatures, rejects unsigned from trusted", async () => {
      const store = new FleetChatStore(
        `/tmp/fleet-chat-test-${Date.now()}.db`,
        undefined,
        { requireSignatures: true },
      );
      store.setLocalIdentity(LOCAL_FLEET);

      const trustedFleet: FleetIdentity = {
        name: "requires-sig",
        endpoint: "https://requires-sig.vm.vers.sh:3000",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIECLWJulrdIzkLMbSt3n3fopUC5vMm2kEH9vQVQhSDEB test",
      };
      store.addTrustedEndpoint(trustedFleet);

      // Non-Ed25519 (not 64 bytes) signature should be rejected
      const result = await store.receiveInbound({
        from: trustedFleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "no real sig",
        timestamp: new Date().toISOString(),
        signature: "hash-based-placeholder",
      });
      expect(result.quarantined).toBeTruthy();
      expect(result.quarantined!.reason).toContain("Missing Ed25519 signature");
    });
  });

  // ── Crypto (legacy) ─────────────────────────────────────────────────
  describe("crypto (legacy helpers)", () => {
    it("generates key pairs", () => {
      const { publicKey, privateKey } = generateKeyPair();
      expect(publicKey).toContain("PUBLIC KEY");
      expect(privateKey).toContain("PRIVATE KEY");
    });

    it("signs and verifies with real keys", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const content = "test message";
      const timestamp = new Date().toISOString();
      const sig = signMessage(content, timestamp, privateKey);
      expect(verifySignature(content, timestamp, sig, publicKey)).toBe(true);
    });

    it("rejects tampered content", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const timestamp = new Date().toISOString();
      const sig = signMessage("original", timestamp, privateKey);
      expect(verifySignature("tampered", timestamp, sig, publicKey)).toBe(false);
    });

    it("hash-based signatures work without keys", () => {
      const content = "no key message";
      const timestamp = new Date().toISOString();
      const sig = signMessage(content, timestamp);
      expect(verifySignature(content, timestamp, sig, "not-a-real-key")).toBe(true);
    });
  });
});
