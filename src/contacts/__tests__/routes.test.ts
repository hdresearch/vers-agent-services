import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { ContactsStore } from "../store.js";
import { contactsRoutes, contactsPublicRoutes, contactsStore } from "../routes.js";
import { fleetChatStore } from "../../fleet-chat/routes.js";

// Set up local identity for peering tests
beforeAll(() => {
  fleetChatStore.setLocalIdentity({
    name: "test-fleet",
    endpoint: "https://test.example.com:3000",
    publicKey: "ssh-ed25519 test-key",
  });
});

const app = new Hono();
// Public routes first (no auth in test)
app.route("/contacts", contactsPublicRoutes);
app.route("/contacts", contactsRoutes);

function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return app.request(`http://localhost/contacts${path}`, opts);
}

describe("Contacts Routes", () => {
  let contactId: string;

  it("POST / — create contact", async () => {
    const res = await req("POST", "/", {
      commonName: "joseph",
      fleetName: "joseph-fleet",
      endpoint: "https://joseph.example.com:3000",
      publicKey: "ssh-ed25519 josephkey",
      trustLevel: "trusted",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.commonName).toBe("joseph");
    expect(data.trustLevel).toBe("trusted");
    contactId = data.id;
  });

  it("GET / — list contacts", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  it("GET /:id — get contact", async () => {
    const res = await req("GET", `/${contactId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commonName).toBe("joseph");
  });

  it("PUT /:id — update contact", async () => {
    const res = await req("PUT", `/${contactId}`, { fleetName: "jo-fleet-v2" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fleetName).toBe("jo-fleet-v2");
  });

  it("GET /?trustLevel=trusted — filter by trust", async () => {
    const res = await req("GET", "/?trustLevel=trusted");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.contacts.every((c: any) => c.trustLevel === "trusted")).toBe(true);
  });

  it("POST / — validation error", async () => {
    const res = await req("POST", "/", { commonName: "" });
    expect(res.status).toBe(400);
  });

  it("GET /nonexistent — 404", async () => {
    const res = await req("GET", "/nonexistent-id");
    expect(res.status).toBe(404);
  });
});

describe("Peering Routes", () => {
  let inviteToken: string;

  it("POST /peer/invite — create invite", async () => {
    const res = await req("POST", "/peer/invite", { label: "for-barton" });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.invite.token).toMatch(/^peer_/);
    expect(data.url).toContain("/contacts/peer/accept?token=");
    inviteToken = data.invite.token;
  });

  it("GET /peer/accept?token=XXX — show identity", async () => {
    const res = await req("GET", `/peer/accept?token=${inviteToken}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ourIdentity.name).toBe("test-fleet");
  });

  it("GET /peer/accept — missing token", async () => {
    const res = await req("GET", "/peer/accept");
    expect(res.status).toBe(400);
  });

  it("POST /peer/accept — complete peering", async () => {
    const res = await req("POST", `/peer/accept?token=${inviteToken}`, {
      name: "barton-fleet",
      endpoint: "https://barton.example.com:3000",
      publicKey: "ssh-ed25519 bartonkey",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.peered).toBe(true);
    expect(data.ourIdentity.name).toBe("test-fleet");
    expect(data.addUsAs.name).toBe("test-fleet");
    expect(data.contact.name).toBe("barton-fleet");
  });

  it("POST /peer/accept — reuse token fails", async () => {
    const res = await req("POST", `/peer/accept?token=${inviteToken}`, {
      name: "attacker",
      endpoint: "https://evil.com",
      publicKey: "ssh-ed25519 evil",
    });
    expect(res.status).toBe(404);
  });

  it("GET /peer/invites — list invites", async () => {
    const res = await req("GET", "/peer/invites");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBeGreaterThanOrEqual(1);
  });
});
