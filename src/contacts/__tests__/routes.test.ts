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
// Public peer routes first (no auth needed — matches server.ts pattern)
app.route("/contacts", contactsPublicRoutes);
// Then authenticated routes (bearerAuth checks VERS_AUTH_TOKEN if set)
// Note: Hono cascades through routes in order — public routes only handle /peer/accept
app.route("/contacts", contactsRoutes);

function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Include bearer token if VERS_AUTH_TOKEN is set (needed for /:id routes with bearerAuth)
  if (process.env.VERS_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.VERS_AUTH_TOKEN}`;
  }
  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  // Normalize paths to avoid Hono trailing-slash 404:
  // "/"           → ""       (no trailing slash)
  // "/?q=1"       → "?q=1"  (query on root)
  // "/peer/..."   → "/peer/..."  (sub-paths unchanged)
  let fullPath = path;
  if (fullPath === "/") fullPath = "";
  else if (fullPath.startsWith("/?")) fullPath = fullPath.slice(1); // "/?q=1" → "?q=1"
  return app.request(`http://localhost/contacts${fullPath}`, opts);
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
