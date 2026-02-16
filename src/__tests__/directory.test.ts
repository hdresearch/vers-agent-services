import { describe, it, expect, beforeEach } from "vitest";
import { DirectoryStore, ValidationError, NotFoundError } from "../directory/store.js";
import { seedDirectory } from "../directory/seed.js";

function tmpDb(): string {
  return `/tmp/directory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("DirectoryStore", () => {
  let store: DirectoryStore;

  beforeEach(() => {
    store = new DirectoryStore(tmpDb());
  });

  describe("create", () => {
    it("creates a person with defaults", () => {
      const person = store.create({ name: "Alice" });
      expect(person.id).toBeTruthy();
      expect(person.name).toBe("Alice");
      expect(person.type).toBe("human");
      expect(person.trustLevel).toBe("unknown");
      expect(person.aliases).toEqual([]);
      expect(person.tags).toEqual([]);
      expect(person.notes).toEqual([]);
      expect(person.createdBy).toBe("system");
    });

    it("creates a person with full fields", () => {
      const person = store.create({
        name: "Joseph",
        aliases: ["joseph", "joseph-fleet"],
        type: "human",
        relationship: "Fleet operator",
        trustLevel: "trusted",
        tags: ["vers", "fleet"],
        projects: ["joseph-fleet"],
        github: "josephgh",
        email: "joseph@example.com",
        createdBy: "borges",
        fleetIdentity: {
          name: "joseph-fleet",
          endpoint: "https://example.com:3000",
          publicKey: "ssh-ed25519 AAAA...",
          channelId: "ch-123",
        },
      });

      expect(person.name).toBe("Joseph");
      expect(person.aliases).toEqual(["joseph", "joseph-fleet"]);
      expect(person.type).toBe("human");
      expect(person.trustLevel).toBe("trusted");
      expect(person.github).toBe("josephgh");
      expect(person.email).toBe("joseph@example.com");
      expect(person.fleetIdentity?.name).toBe("joseph-fleet");
      expect(person.fleetIdentity?.channelId).toBe("ch-123");
      expect(person.createdBy).toBe("borges");
    });

    it("creates a person with initial notes", () => {
      const person = store.create({
        name: "Bob",
        notes: [
          { content: "First note", author: "agent-1", source: "manual" },
          { content: "Second note", author: "agent-2", source: "fleet-chat" },
        ],
      });

      expect(person.notes).toHaveLength(2);
      expect(person.notes[0].content).toBe("First note");
      expect(person.notes[1].source).toBe("fleet-chat");
    });

    it("rejects empty name", () => {
      expect(() => store.create({ name: "" })).toThrow(ValidationError);
      expect(() => store.create({ name: "  " })).toThrow(ValidationError);
    });

    it("rejects invalid type", () => {
      expect(() => store.create({ name: "X", type: "robot" as any })).toThrow(ValidationError);
    });

    it("rejects invalid trustLevel", () => {
      expect(() => store.create({ name: "X", trustLevel: "bff" as any })).toThrow(ValidationError);
    });
  });

  describe("get", () => {
    it("retrieves an existing person", () => {
      const created = store.create({ name: "Alice" });
      const fetched = store.get(created.id);
      expect(fetched.name).toBe("Alice");
    });

    it("throws NotFoundError for missing id", () => {
      expect(() => store.get("nonexistent")).toThrow(NotFoundError);
    });
  });

  describe("list", () => {
    it("returns all people", () => {
      store.create({ name: "Alice", type: "human" });
      store.create({ name: "Bob", type: "fleet" });
      const result = store.list();
      expect(result).toHaveLength(2);
    });

    it("filters by type", () => {
      store.create({ name: "Alice", type: "human" });
      store.create({ name: "Bot-Fleet", type: "fleet" });
      const humans = store.list({ type: "human" });
      expect(humans).toHaveLength(1);
      expect(humans[0].name).toBe("Alice");
    });

    it("filters by trustLevel", () => {
      store.create({ name: "Stranger", trustLevel: "unknown" });
      store.create({ name: "Friend", trustLevel: "close" });
      const close = store.list({ trustLevel: "close" });
      expect(close).toHaveLength(1);
      expect(close[0].name).toBe("Friend");
    });

    it("searches by name with q parameter", () => {
      store.create({ name: "Alice Wonderland" });
      store.create({ name: "Bob Builder" });
      const results = store.list({ q: "alice" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice Wonderland");
    });

    it("searches aliases with q parameter", () => {
      store.create({ name: "Joseph", aliases: ["joe", "joseph-fleet"] });
      store.create({ name: "Bob" });
      const results = store.list({ q: "joseph-fleet" });
      expect(results).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates specific fields", () => {
      const person = store.create({ name: "Alice", trustLevel: "unknown" });
      const updated = store.update(person.id, { trustLevel: "trusted", tags: ["friend"] });
      expect(updated.trustLevel).toBe("trusted");
      expect(updated.tags).toEqual(["friend"]);
      expect(updated.name).toBe("Alice"); // unchanged
    });

    it("clears optional fields with null", () => {
      const person = store.create({ name: "Alice", github: "alice123", email: "a@b.com" });
      const updated = store.update(person.id, { github: null, email: null });
      expect(updated.github).toBeUndefined();
      expect(updated.email).toBeUndefined();
    });

    it("returns unchanged if no updates", () => {
      const person = store.create({ name: "Alice" });
      const same = store.update(person.id, {});
      expect(same.name).toBe("Alice");
    });

    it("throws NotFoundError for missing id", () => {
      expect(() => store.update("nonexistent", { name: "Bob" })).toThrow(NotFoundError);
    });
  });

  describe("delete", () => {
    it("deletes an existing person", () => {
      const person = store.create({ name: "Alice" });
      store.delete(person.id);
      expect(() => store.get(person.id)).toThrow(NotFoundError);
    });

    it("throws NotFoundError for missing id", () => {
      expect(() => store.delete("nonexistent")).toThrow(NotFoundError);
    });
  });

  describe("notes", () => {
    it("adds a note to a person", () => {
      const person = store.create({ name: "Alice" });
      const note = store.addNote(person.id, {
        content: "Met at conference",
        author: "borges",
        source: "manual",
      });

      expect(note.id).toBeTruthy();
      expect(note.content).toBe("Met at conference");
      expect(note.author).toBe("borges");
      expect(note.source).toBe("manual");
    });

    it("retrieves notes with person", () => {
      const person = store.create({ name: "Alice" });
      store.addNote(person.id, { content: "Note 1", author: "a1" });
      store.addNote(person.id, { content: "Note 2", author: "a2", source: "fleet-chat" });

      const fetched = store.get(person.id);
      expect(fetched.notes).toHaveLength(2);
      expect(fetched.notes[0].content).toBe("Note 1");
      expect(fetched.notes[1].source).toBe("fleet-chat");
    });

    it("rejects empty content", () => {
      const person = store.create({ name: "Alice" });
      expect(() => store.addNote(person.id, { content: "", author: "a1" })).toThrow(ValidationError);
    });

    it("rejects empty author", () => {
      const person = store.create({ name: "Alice" });
      expect(() => store.addNote(person.id, { content: "test", author: "" })).toThrow(ValidationError);
    });

    it("throws NotFoundError for missing person", () => {
      expect(() => store.addNote("nonexistent", { content: "test", author: "a1" })).toThrow(NotFoundError);
    });
  });

  describe("relationships", () => {
    it("adds a relationship between two people", () => {
      const alice = store.create({ name: "Alice" });
      const bob = store.create({ name: "Bob" });
      store.addRelationship(alice.id, bob.id, "colleagues");

      const graph = store.graph();
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].from).toBe(alice.id);
      expect(graph.edges[0].to).toBe(bob.id);
      expect(graph.edges[0].relationship).toBe("colleagues");
    });

    it("updates existing relationship on duplicate", () => {
      const alice = store.create({ name: "Alice" });
      const bob = store.create({ name: "Bob" });
      store.addRelationship(alice.id, bob.id, "acquaintances");
      store.addRelationship(alice.id, bob.id, "close friends");

      const graph = store.graph();
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].relationship).toBe("close friends");
    });

    it("removes a relationship", () => {
      const alice = store.create({ name: "Alice" });
      const bob = store.create({ name: "Bob" });
      store.addRelationship(alice.id, bob.id, "colleagues");
      store.removeRelationship(alice.id, bob.id);

      const graph = store.graph();
      expect(graph.edges).toHaveLength(0);
    });
  });

  describe("graph", () => {
    it("returns nodes and edges", () => {
      const alice = store.create({ name: "Alice", type: "human", trustLevel: "trusted" });
      const bob = store.create({ name: "Bob", type: "fleet", trustLevel: "unknown" });
      store.addRelationship(alice.id, bob.id, "peers");

      const graph = store.graph();
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.nodes.find((n) => n.name === "Alice")?.type).toBe("human");
      expect(graph.nodes.find((n) => n.name === "Bob")?.type).toBe("fleet");
    });
  });

  describe("findByName", () => {
    it("finds by exact name (case-insensitive)", () => {
      store.create({ name: "Joseph" });
      const found = store.findByName("joseph");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Joseph");
    });

    it("finds by alias", () => {
      store.create({ name: "Joe Mistachkin", aliases: ["joe m", "mistachkin"] });
      const found = store.findByName("mistachkin");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Joe Mistachkin");
    });

    it("returns null for unknown name", () => {
      const found = store.findByName("nobody");
      expect(found).toBeNull();
    });
  });

  describe("search (FTS)", () => {
    it("finds by name via FTS", () => {
      store.create({ name: "Joseph Fleet Operator", tags: ["vers"] });
      store.create({ name: "Bob Builder" });
      const results = store.search("Joseph");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toContain("Joseph");
    });

    it("finds by note content via FTS", () => {
      const person = store.create({ name: "Alice" });
      store.addNote(person.id, { content: "Works on thorium project", author: "borges" });
      const results = store.search("thorium");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty for no match", () => {
      store.create({ name: "Alice" });
      const results = store.search("zzzznonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("count", () => {
    it("counts people", () => {
      expect(store.count).toBe(0);
      store.create({ name: "Alice" });
      store.create({ name: "Bob" });
      expect(store.count).toBe(2);
    });
  });
});

describe("seedDirectory", () => {
  it("seeds known people into empty store", () => {
    const store = new DirectoryStore(tmpDb());
    const count = seedDirectory(store);
    expect(count).toBe(6); // Noah, Joseph, Joe M, Ben, Barton, Obinna

    const all = store.list();
    expect(all.length).toBe(6);

    // Verify key people
    const noah = store.findByName("Noah Sluss");
    expect(noah).not.toBeNull();
    expect(noah!.trustLevel).toBe("close");
    expect(noah!.type).toBe("human");

    const joseph = store.findByName("Joseph");
    expect(joseph).not.toBeNull();
    expect(joseph!.fleetIdentity?.name).toBe("joseph-fleet");
    expect(joseph!.fleetIdentity?.channelId).toBe("01KHFV9CDFCV9VXCS3W2YVJ5NG");

    const joeM = store.findByName("Joe Mistachkin");
    expect(joeM).not.toBeNull();
    expect(joeM!.github).toBe("mistachkin");
    expect(joeM!.projects).toContain("thorium");

    // Verify relationships were created
    const graph = store.graph();
    expect(graph.edges.length).toBeGreaterThan(0);
    // Noah->Joseph relationship should exist
    const noahJoseph = graph.edges.find((e) => e.from === noah!.id && e.to === joseph!.id);
    expect(noahJoseph).toBeDefined();

    store.close();
  });

  it("does not re-seed non-empty store", () => {
    const store = new DirectoryStore(tmpDb());
    store.create({ name: "Existing Person" });
    const count = seedDirectory(store);
    expect(count).toBe(0);
    expect(store.count).toBe(1);
    store.close();
  });
});
