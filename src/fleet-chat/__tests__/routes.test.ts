import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { fleetChatRoutes, fleetChatPublicRoutes, fleetChatStore } from "../routes.js";
import { signMessage } from "../store.js";

const app = new Hono();
app.route("/fleet-chat", fleetChatRoutes);
app.route("/fleet-chat", fleetChatPublicRoutes);

async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  return app.request(`http://localhost/fleet-chat${path}`, opts);
}

const LOCAL_FLEET = {
  name: "test-fleet",
  endpoint: "https://test.vm.vers.sh:3000",
  publicKey: "pk-test-local",
};

const REMOTE_FLEET = {
  name: "remote-fleet",
  endpoint: "https://remote.vm.vers.sh:3000",
  publicKey: "pk-test-remote",
};

describe("Fleet Chat Routes", () => {
  // Set up local identity
  beforeAll(async () => {
    await req("POST", "/identity", LOCAL_FLEET);
  });

  // ── Identity ─────────────────────────────────────────────────────────
  describe("POST /identity", () => {
    it("sets local identity", async () => {
      const res = await req("POST", "/identity", LOCAL_FLEET);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("test-fleet");
    });

    it("rejects invalid identity", async () => {
      const res = await req("POST", "/identity", { name: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /identity", () => {
    it("returns local identity", async () => {
      const res = await req("GET", "/identity");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("test-fleet");
    });
  });

  // ── Channels ─────────────────────────────────────────────────────────
  describe("POST /channels", () => {
    it("creates a channel", async () => {
      const res = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeTruthy();
      expect(data.remoteFleet.name).toBe("remote-fleet");
      expect(data.status).toBe("active");
    });

    it("returns existing channel (idempotent)", async () => {
      const res1 = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const res2 = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const data1 = await res1.json();
      const data2 = await res2.json();
      expect(data1.id).toBe(data2.id);
    });

    it("rejects invalid remote fleet", async () => {
      const res = await req("POST", "/channels", { remoteFleet: { name: "" } });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /channels", () => {
    it("lists channels", async () => {
      const res = await req("GET", "/channels");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.channels).toBeDefined();
      expect(data.count).toBeGreaterThan(0);
    });
  });

  describe("GET /channels/:id", () => {
    it("gets a channel by id", async () => {
      const createRes = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const ch = await createRes.json();

      const res = await req("GET", `/channels/${ch.id}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(ch.id);
    });

    it("404 for unknown channel", async () => {
      const res = await req("GET", "/channels/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /channels/:id", () => {
    it("updates channel status", async () => {
      // Create a fresh channel for this test
      const otherFleet = { ...REMOTE_FLEET, endpoint: "https://other.vm.vers.sh:3000", publicKey: "pk-other" };
      const createRes = await req("POST", "/channels", { remoteFleet: otherFleet });
      const ch = await createRes.json();

      const res = await req("PATCH", `/channels/${ch.id}`, { status: "archived" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("archived");
    });
  });

  // ── Messages ─────────────────────────────────────────────────────────
  describe("POST /channels/:id/messages", () => {
    it("sends a message", async () => {
      const chRes = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const ch = await chRes.json();

      const res = await req("POST", `/channels/${ch.id}/messages`, {
        content: "Hello from tests!",
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.content).toBe("Hello from tests!");
      expect(data.type).toBe("text");
      expect(data.signature).toBeTruthy();
    });

    it("supports message types", async () => {
      const chRes = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const ch = await chRes.json();

      const res = await req("POST", `/channels/${ch.id}/messages`, {
        content: "task payload",
        type: "task",
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.type).toBe("task");
    });

    it("rejects empty content", async () => {
      const chRes = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const ch = await chRes.json();

      const res = await req("POST", `/channels/${ch.id}/messages`, { content: "" });
      expect(res.status).toBe(400);
    });

    it("404 for unknown channel", async () => {
      const res = await req("POST", "/channels/nonexistent/messages", { content: "hi" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /channels/:id/messages", () => {
    it("gets messages", async () => {
      const chRes = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const ch = await chRes.json();

      // Send a few messages
      await req("POST", `/channels/${ch.id}/messages`, { content: "msg A" });
      await req("POST", `/channels/${ch.id}/messages`, { content: "msg B" });

      const res = await req("GET", `/channels/${ch.id}/messages`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages.length).toBeGreaterThanOrEqual(2);
    });

    it("supports limit parameter", async () => {
      const chRes = await req("POST", "/channels", { remoteFleet: REMOTE_FLEET });
      const ch = await chRes.json();

      const res = await req("GET", `/channels/${ch.id}/messages?limit=1`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages.length).toBeLessThanOrEqual(1);
    });

    it("404 for unknown channel", async () => {
      const res = await req("GET", "/channels/nonexistent/messages");
      expect(res.status).toBe(404);
    });
  });

  // ── Public Inbox ─────────────────────────────────────────────────────
  describe("POST /inbox", () => {
    it("receives message from trusted sender", async () => {
      // Ensure remote fleet is trusted
      await req("POST", "/trusted", REMOTE_FLEET);

      const timestamp = new Date().toISOString();
      const sig = signMessage("hello from remote", timestamp);

      const res = await req("POST", "/inbox", {
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "hello from remote",
        timestamp,
        signature: sig,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);
      expect(data.messageId).toBeTruthy();
    });

    it("quarantines message from unknown sender", async () => {
      const unknownFleet = {
        name: "unknown-fleet",
        endpoint: "https://unknown.vm.vers.sh:3000",
        publicKey: "pk-unknown",
      };

      const timestamp = new Date().toISOString();
      const sig = signMessage("suspicious message", timestamp);

      const res = await req("POST", "/inbox", {
        from: unknownFleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "suspicious message",
        timestamp,
        signature: sig,
      });

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.received).toBe(true);
      expect(data.quarantined).toBe(true);
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("http://localhost/fleet-chat/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing signature", async () => {
      const res = await req("POST", "/inbox", {
        from: REMOTE_FLEET,
        to: LOCAL_FLEET,
        type: "text",
        content: "no sig",
        timestamp: new Date().toISOString(),
        signature: "",
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Trusted Endpoints ────────────────────────────────────────────────
  describe("GET /trusted", () => {
    it("lists trusted endpoints", async () => {
      const res = await req("GET", "/trusted");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.endpoints).toBeDefined();
    });
  });

  describe("POST /trusted", () => {
    it("adds a trusted endpoint", async () => {
      const newFleet = {
        name: "new-trusted",
        endpoint: "https://new-trusted.vm.vers.sh:3000",
        publicKey: "pk-new-trusted",
      };
      const res = await req("POST", "/trusted", newFleet);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("new-trusted");
    });
  });

  // ── Quarantine ───────────────────────────────────────────────────────
  describe("GET /quarantine", () => {
    it("lists quarantined messages", async () => {
      const res = await req("GET", "/quarantine");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.quarantine).toBeDefined();
    });
  });

  describe("POST /quarantine/:id/approve", () => {
    it("approves a quarantined message", async () => {
      const unknownFleet2 = {
        name: "approvable-fleet",
        endpoint: "https://approvable.vm.vers.sh:3000",
        publicKey: "pk-approvable",
      };

      const timestamp = new Date().toISOString();
      const sig = signMessage("approve me", timestamp);

      // First, send from unknown to get quarantined
      const inboxRes = await req("POST", "/inbox", {
        from: unknownFleet2,
        to: LOCAL_FLEET,
        type: "text",
        content: "approve me",
        timestamp,
        signature: sig,
      });
      expect(inboxRes.status).toBe(202);

      // Get quarantine list
      const qRes = await req("GET", "/quarantine");
      const qData = await qRes.json();
      const quarantined = qData.quarantine.find((q: any) => q.rawMessage.from.name === "approvable-fleet");
      expect(quarantined).toBeTruthy();

      // Approve
      const approveRes = await req("POST", `/quarantine/${quarantined.id}/approve`);
      expect(approveRes.status).toBe(200);
      const approved = await approveRes.json();
      expect(approved.content).toBe("approve me");
    });
  });

  describe("POST /quarantine/:id/reject", () => {
    it("rejects a quarantined message", async () => {
      const spamFleet = {
        name: "spam-fleet",
        endpoint: "https://spam.vm.vers.sh:3000",
        publicKey: "pk-spam",
      };

      const timestamp = new Date().toISOString();
      const sig = signMessage("spam", timestamp);

      const inboxRes = await req("POST", "/inbox", {
        from: spamFleet,
        to: LOCAL_FLEET,
        type: "text",
        content: "spam",
        timestamp,
        signature: sig,
      });
      expect(inboxRes.status).toBe(202);

      const qRes = await req("GET", "/quarantine");
      const qData = await qRes.json();
      const quarantined = qData.quarantine.find((q: any) => q.rawMessage.from.name === "spam-fleet");

      const rejectRes = await req("POST", `/quarantine/${quarantined.id}/reject`);
      expect(rejectRes.status).toBe(200);
      const data = await rejectRes.json();
      expect(data.rejected).toBe(true);
    });
  });
});
