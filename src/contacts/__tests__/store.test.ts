import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContactsStore, parseGitHubKeys } from "../store.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "data/test-contacts.db";

describe("ContactsStore", () => {
  let store: ContactsStore;

  beforeEach(() => {
    // Clean up any leftover test db
    for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      if (existsSync(f)) unlinkSync(f);
    }
    store = new ContactsStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  describe("CRUD", () => {
    it("should create a contact", () => {
      const contact = store.create({
        commonName: "joseph",
        fleetName: "joseph-fleet",
        endpoint: "https://joseph.example.com:3000",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...",
        trustLevel: "trusted",
      });

      expect(contact.id).toBeTruthy();
      expect(contact.commonName).toBe("joseph");
      expect(contact.fleetName).toBe("joseph-fleet");
      expect(contact.trustLevel).toBe("trusted");
      expect(contact.createdAt).toBeTruthy();
    });

    it("should get a contact by id", () => {
      const created = store.create({ commonName: "barton" });
      const fetched = store.get(created.id);
      expect(fetched.commonName).toBe("barton");
    });

    it("should throw NotFoundError for missing contact", () => {
      expect(() => store.get("nonexistent")).toThrow("not found");
    });

    it("should list contacts", () => {
      store.create({ commonName: "alice", trustLevel: "trusted" });
      store.create({ commonName: "bob", trustLevel: "known" });
      store.create({ commonName: "charlie", trustLevel: "blocked" });

      const all = store.list();
      expect(all.length).toBe(3);

      const trusted = store.list({ trustLevel: "trusted" });
      expect(trusted.length).toBe(1);
      expect(trusted[0].commonName).toBe("alice");
    });

    it("should search contacts", () => {
      store.create({ commonName: "joseph", githubUsername: "josephcooper" });
      store.create({ commonName: "barton" });

      const results = store.list({ search: "joseph" });
      expect(results.length).toBe(1);
      expect(results[0].commonName).toBe("joseph");
    });

    it("should update a contact", () => {
      const created = store.create({ commonName: "joseph", trustLevel: "known" });
      const updated = store.update(created.id, { trustLevel: "trusted", fleetName: "jo-fleet" });

      expect(updated.trustLevel).toBe("trusted");
      expect(updated.fleetName).toBe("jo-fleet");
      expect(updated.commonName).toBe("joseph");
    });

    it("should delete a contact", () => {
      const created = store.create({ commonName: "temp" });
      store.delete(created.id);
      expect(() => store.get(created.id)).toThrow("not found");
    });

    it("should store and retrieve metadata", () => {
      const created = store.create({
        commonName: "test",
        metadata: { keyType: "ssh-ed25519", source: "github" },
      });
      const fetched = store.get(created.id);
      expect(fetched.metadata).toEqual({ keyType: "ssh-ed25519", source: "github" });
    });

    it("should find by github username", () => {
      store.create({ commonName: "gh-user", githubUsername: "octocat" });
      const found = store.findByGithubUsername("octocat");
      expect(found).not.toBeNull();
      expect(found!.commonName).toBe("gh-user");
    });

    it("should find by endpoint", () => {
      store.create({ commonName: "ep-user", endpoint: "https://ep.example.com" });
      const found = store.findByEndpoint("https://ep.example.com");
      expect(found).not.toBeNull();
      expect(found!.commonName).toBe("ep-user");
    });
  });

  describe("Peer Invites", () => {
    it("should create a peer invite", () => {
      const invite = store.createPeerInvite({ label: "for-joseph" });
      expect(invite.id).toBeTruthy();
      expect(invite.token).toMatch(/^peer_/);
      expect(invite.status).toBe("active");
      expect(invite.label).toBe("for-joseph");
    });

    it("should validate an active invite", () => {
      const invite = store.createPeerInvite();
      const valid = store.validatePeerInvite(invite.token);
      expect(valid).not.toBeNull();
      expect(valid!.id).toBe(invite.id);
    });

    it("should reject invalid token", () => {
      const valid = store.validatePeerInvite("bogus_token");
      expect(valid).toBeNull();
    });

    it("should redeem an invite", () => {
      const invite = store.createPeerInvite();
      const contact = store.create({ commonName: "peer", trustLevel: "trusted" });
      const redeemed = store.redeemPeerInvite(invite.token, contact.id, "peer");

      expect(redeemed.status).toBe("redeemed");
      expect(redeemed.redeemedBy).toBe("peer");
      expect(redeemed.contactId).toBe(contact.id);
    });

    it("should not allow double-redeem", () => {
      const invite = store.createPeerInvite();
      const contact = store.create({ commonName: "peer" });
      store.redeemPeerInvite(invite.token, contact.id, "peer");

      // Second redeem should fail
      expect(() => store.redeemPeerInvite(invite.token, contact.id, "peer")).toThrow();
    });

    it("should list invites filtered by status", () => {
      store.createPeerInvite({ label: "active-one" });
      const inv2 = store.createPeerInvite({ label: "to-redeem" });
      const contact = store.create({ commonName: "p" });
      store.redeemPeerInvite(inv2.token, contact.id, "p");

      const active = store.listPeerInvites("active");
      expect(active.length).toBe(1);
      expect(active[0].label).toBe("active-one");

      const redeemed = store.listPeerInvites("redeemed");
      expect(redeemed.length).toBe(1);
    });
  });
});

describe("parseGitHubKeys", () => {
  it("should prefer ed25519 keys", () => {
    const body = `ssh-rsa AAAAB3NzaC1yc2EAAAA...
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...
ssh-rsa AAAAB3NzaC1yc2EAAAA2...`;
    const result = parseGitHubKeys(body);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("ssh-ed25519");
    expect(result!.key).toContain("ssh-ed25519");
  });

  it("should fall back to first key if no ed25519", () => {
    const body = `ssh-rsa AAAAB3NzaC1yc2EAAAA...
ssh-rsa AAAAB3NzaC1yc2EAAAA2...`;
    const result = parseGitHubKeys(body);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("ssh-rsa");
  });

  it("should return null for empty body", () => {
    expect(parseGitHubKeys("")).toBeNull();
    expect(parseGitHubKeys("\n\n")).toBeNull();
  });
});
