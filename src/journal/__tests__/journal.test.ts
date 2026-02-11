import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JournalStore, ValidationError } from "../store.js";
import { bearerAuth } from "../../auth.js";

// --- Store unit tests ---

describe("JournalStore", () => {
  let store: JournalStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "journal-test-"));
    filePath = join(tmpDir, "journal.jsonl");
    store = new JournalStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("append", () => {
    it("creates an entry with id and timestamp", () => {
      const entry = store.append({ text: "Feeling optimistic about the architecture" });
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.text).toBe("Feeling optimistic about the architecture");
      expect(entry.author).toBeUndefined();
      expect(entry.mood).toBeUndefined();
      expect(entry.tags).toBeUndefined();
    });

    it("accepts optional author, mood, and tags", () => {
      const entry = store.append({
        text: "Great progress today",
        author: "noah",
        mood: "excited",
        tags: ["product", "milestone"],
      });
      expect(entry.author).toBe("noah");
      expect(entry.mood).toBe("excited");
      expect(entry.tags).toEqual(["product", "milestone"]);
    });

    it("trims whitespace", () => {
      const entry = store.append({
        text: "  hello  ",
        author: "  noah  ",
        mood: "  good  ",
      });
      expect(entry.text).toBe("hello");
      expect(entry.author).toBe("noah");
      expect(entry.mood).toBe("good");
    });

    it("filters empty tags", () => {
      const entry = store.append({
        text: "test",
        tags: ["valid", "", "  ", "also-valid"],
      });
      expect(entry.tags).toEqual(["valid", "also-valid"]);
    });

    it("omits tags if all empty", () => {
      const entry = store.append({ text: "test", tags: ["", "  "] });
      expect(entry.tags).toBeUndefined();
    });

    it("rejects empty text", () => {
      expect(() => store.append({ text: "" })).toThrow(ValidationError);
      expect(() => store.append({ text: "   " })).toThrow(ValidationError);
    });

    it("increments size", () => {
      expect(store.size).toBe(0);
      store.append({ text: "one" });
      store.append({ text: "two" });
      expect(store.size).toBe(2);
    });
  });

  describe("query", () => {
    it("returns entries in chronological order", () => {
      store.append({ text: "first" });
      store.append({ text: "second" });
      store.append({ text: "third" });
      const entries = store.query({ last: "1h" });
      expect(entries).toHaveLength(3);
      expect(entries[0].text).toBe("first");
      expect(entries[2].text).toBe("third");
    });

    it("defaults to last 24h", () => {
      store.append({ text: "recent" });
      const entries = store.query({});
      expect(entries).toHaveLength(1);
    });

    it("filters by since", async () => {
      store.append({ text: "old" });
      await new Promise((r) => setTimeout(r, 10));
      const sinceTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      store.append({ text: "new" });
      const entries = store.query({ since: sinceTime });
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("new");
    });

    it("filters by last duration", () => {
      store.append({ text: "recent" });
      expect(store.query({ last: "1h" })).toHaveLength(1);
      expect(store.query({ last: "7d" })).toHaveLength(1);
    });

    it("filters by author", () => {
      store.append({ text: "by noah", author: "noah" });
      store.append({ text: "by bot", author: "bot" });
      const entries = store.query({ last: "1h", author: "noah" });
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("by noah");
    });

    it("filters by tag", () => {
      store.append({ text: "tagged", tags: ["product", "vibes"] });
      store.append({ text: "other", tags: ["ops"] });
      store.append({ text: "no tags" });
      const entries = store.query({ last: "1h", tag: "product" });
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("tagged");
    });
  });

  describe("formatRaw", () => {
    it("formats entries as plain text with all fields", () => {
      const entries = [
        {
          id: "1",
          timestamp: "2026-02-10T15:30:00.000Z",
          text: "Feeling good about this",
          author: "noah",
          mood: "excited",
          tags: ["product"],
        },
        { id: "2", timestamp: "2026-02-10T15:31:00.000Z", text: "Just a thought" },
      ];
      const raw = store.formatRaw(entries);
      expect(raw).toBe(
        "[2026-02-10T15:30:00.000Z] (noah) [excited] #product Feeling good about this\n" +
          "[2026-02-10T15:31:00.000Z] Just a thought"
      );
    });

    it("handles empty list", () => {
      expect(store.formatRaw([])).toBe("");
    });
  });

  describe("persistence", () => {
    it("persists as JSONL and reloads", () => {
      store.append({ text: "entry one", author: "noah", mood: "calm", tags: ["reflection"] });
      store.append({ text: "entry two" });

      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).text).toBe("entry one");
      expect(JSON.parse(lines[0]).mood).toBe("calm");

      const store2 = new JournalStore(filePath);
      expect(store2.size).toBe(2);
      const entries = store2.query({ last: "1h" });
      expect(entries[0].author).toBe("noah");
      expect(entries[0].tags).toEqual(["reflection"]);
    });

    it("starts fresh if file is missing", () => {
      const freshStore = new JournalStore(join(tmpDir, "nonexistent.jsonl"));
      expect(freshStore.size).toBe(0);
    });
  });
});

// --- Route integration tests ---

describe("Journal Routes", () => {
  let app: Hono;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "journal-route-test-"));
    const { journalRoutes } = await import("../routes.js");
    app = new Hono();
    app.route("/journal", journalRoutes);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const json = (body: any) => ({
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("POST /journal — appends an entry", async () => {
    const res = await app.request("/journal", json({
      text: "The architecture is coming together",
      author: "noah",
      mood: "inspired",
      tags: ["product"],
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.text).toBe("The architecture is coming together");
    expect(body.author).toBe("noah");
    expect(body.mood).toBe("inspired");
    expect(body.tags).toEqual(["product"]);
    expect(body.id).toBeTruthy();
  });

  it("POST /journal — 400 on missing text", async () => {
    const res = await app.request("/journal", json({ author: "noah" }));
    expect(res.status).toBe(400);
  });

  it("GET /journal — returns entries with count", async () => {
    await app.request("/journal", json({ text: "one" }));
    await app.request("/journal", json({ text: "two" }));
    const res = await app.request("/journal?last=1h");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
  });

  it("GET /journal?author= — filters by author", async () => {
    // Use unique author names to avoid cross-test pollution from shared store
    const unique = `author-${Date.now()}`;
    await app.request("/journal", json({ text: "by unique", author: unique }));
    await app.request("/journal", json({ text: "by bot", author: "bot-other" }));
    const res = await app.request(`/journal?last=1h&author=${unique}`);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.entries[0].author).toBe(unique);
  });

  it("GET /journal?tag= — filters by tag", async () => {
    const unique = `tag-${Date.now()}`;
    await app.request("/journal", json({ text: "tagged", tags: [unique] }));
    await app.request("/journal", json({ text: "no tag" }));
    const res = await app.request(`/journal?last=1h&tag=${unique}`);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.entries[0].text).toBe("tagged");
  });

  it("GET /journal?raw=true — returns plain text", async () => {
    await app.request("/journal", json({ text: "Thinking about agents", author: "noah", mood: "curious" }));
    const res = await app.request("/journal?last=1h&raw=true");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("(noah)");
    expect(text).toContain("[curious]");
    expect(text).toContain("Thinking about agents");
  });

  it("GET /journal/raw — returns plain text", async () => {
    await app.request("/journal", json({ text: "Raw format test", tags: ["test"] }));
    const res = await app.request("/journal/raw?last=1h");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#test");
    expect(text).toContain("Raw format test");
  });
});

// --- Auth tests ---

describe("Journal Auth", () => {
  let app: Hono;

  beforeEach(async () => {
    const { journalRoutes } = await import("../routes.js");
    app = new Hono();
    app.use("/journal/*", bearerAuth());
    app.route("/journal", journalRoutes);
  });

  it("rejects requests without token when auth is configured", async () => {
    const origToken = process.env.VERS_AUTH_TOKEN;
    process.env.VERS_AUTH_TOKEN = "test-secret-token";
    try {
      const res = await app.request("/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(401);

      const getRes = await app.request("/journal");
      expect(getRes.status).toBe(401);
    } finally {
      if (origToken !== undefined) {
        process.env.VERS_AUTH_TOKEN = origToken;
      } else {
        delete process.env.VERS_AUTH_TOKEN;
      }
    }
  });

  it("allows requests with valid token", async () => {
    const origToken = process.env.VERS_AUTH_TOKEN;
    process.env.VERS_AUTH_TOKEN = "test-secret-token";
    try {
      const res = await app.request("/journal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret-token",
        },
        body: JSON.stringify({ text: "authorized entry" }),
      });
      expect(res.status).toBe(201);
    } finally {
      if (origToken !== undefined) {
        process.env.VERS_AUTH_TOKEN = origToken;
      } else {
        delete process.env.VERS_AUTH_TOKEN;
      }
    }
  });
});
