import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LogStore, ValidationError } from "../store.js";
import { bearerAuth } from "../../auth.js";

// --- Store unit tests ---

describe("LogStore", () => {
  let store: LogStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "log-test-"));
    filePath = join(tmpDir, "log.jsonl");
    store = new LogStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("append", () => {
    it("creates an entry with id and timestamp", () => {
      const entry = store.append({ text: "Started debugging" });
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.text).toBe("Started debugging");
      expect(entry.agent).toBeUndefined();
    });

    it("accepts an optional agent", () => {
      const entry = store.append({ text: "Found the bug", agent: "orchestrator" });
      expect(entry.agent).toBe("orchestrator");
    });

    it("trims whitespace", () => {
      const entry = store.append({ text: "  hello  ", agent: "  bot  " });
      expect(entry.text).toBe("hello");
      expect(entry.agent).toBe("bot");
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
      expect(entries[1].text).toBe("second");
      expect(entries[2].text).toBe("third");
    });

    it("defaults to last 24h", () => {
      store.append({ text: "recent" });
      const entries = store.query({});
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("recent");
    });

    it("filters by since", async () => {
      store.append({ text: "old" });
      // Use a since time after the first entry
      await new Promise((r) => setTimeout(r, 10));
      const sinceTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      store.append({ text: "new" });
      const entries = store.query({ since: sinceTime });
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("new");
    });

    it("filters by until", () => {
      store.append({ text: "included" });
      const untilTime = new Date(Date.now() + 1000).toISOString();
      const entries = store.query({ until: untilTime, last: "1h" });
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("included");
    });

    it("filters by last duration (hours)", () => {
      store.append({ text: "recent" });
      const entries = store.query({ last: "1h" });
      expect(entries).toHaveLength(1);
    });

    it("filters by last duration (days)", () => {
      store.append({ text: "recent" });
      const entries = store.query({ last: "7d" });
      expect(entries).toHaveLength(1);
    });

    it("since overrides last", () => {
      store.append({ text: "entry" });
      // since in the future — should return nothing
      const futureTime = new Date(Date.now() + 100000).toISOString();
      const entries = store.query({ last: "24h", since: futureTime });
      expect(entries).toHaveLength(0);
    });
  });

  describe("formatRaw", () => {
    it("formats entries as plain text", () => {
      const entries = [
        { id: "1", timestamp: "2026-02-10T15:30:00.000Z", text: "Found the bug", agent: "orchestrator" },
        { id: "2", timestamp: "2026-02-10T15:31:00.000Z", text: "Fixed it" },
      ];
      const raw = store.formatRaw(entries);
      expect(raw).toBe(
        "[2026-02-10T15:30:00.000Z] (orchestrator) Found the bug\n" +
        "[2026-02-10T15:31:00.000Z] Fixed it"
      );
    });

    it("handles empty list", () => {
      expect(store.formatRaw([])).toBe("");
    });
  });

  describe("persistence", () => {
    it("persists as JSONL and reloads", () => {
      store.append({ text: "entry one", agent: "bot" });
      store.append({ text: "entry two" });

      // Verify JSONL format on disk
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).text).toBe("entry one");
      expect(JSON.parse(lines[1]).text).toBe("entry two");

      // Reload from same file
      const store2 = new LogStore(filePath);
      expect(store2.size).toBe(2);
      const entries = store2.query({ last: "1h" });
      expect(entries[0].text).toBe("entry one");
      expect(entries[0].agent).toBe("bot");
      expect(entries[1].text).toBe("entry two");
    });

    it("starts fresh if file is missing", () => {
      const freshStore = new LogStore(join(tmpDir, "nonexistent.jsonl"));
      expect(freshStore.size).toBe(0);
    });
  });
});

// --- Route integration tests ---

describe("Log Routes", () => {
  let app: Hono;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "log-route-test-"));
    const { logRoutes } = await import("../routes.js");
    app = new Hono();
    app.route("/log", logRoutes);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const json = (body: any) => ({
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("POST /log — appends an entry", async () => {
    const res = await app.request("/log", json({ text: "Working on it", agent: "lt-1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.text).toBe("Working on it");
    expect(body.agent).toBe("lt-1");
    expect(body.id).toBeTruthy();
    expect(body.timestamp).toBeTruthy();
  });

  it("POST /log — 400 on missing text", async () => {
    const res = await app.request("/log", json({ agent: "bot" }));
    expect(res.status).toBe(400);
  });

  it("GET /log — returns entries with count", async () => {
    await app.request("/log", json({ text: "one" }));
    await app.request("/log", json({ text: "two" }));
    const res = await app.request("/log?last=1h");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(body.entries.length).toBe(body.count);
  });

  it("GET /log — default 24h window", async () => {
    await app.request("/log", json({ text: "recent" }));
    const res = await app.request("/log");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it("GET /log?last=1h — filters by duration", async () => {
    await app.request("/log", json({ text: "entry" }));
    const res = await app.request("/log?last=1h");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it("GET /log/raw — returns plain text", async () => {
    await app.request("/log", json({ text: "Found the bug", agent: "orchestrator" }));
    const res = await app.request("/log/raw?last=1h");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("(orchestrator) Found the bug");
    expect(text).toMatch(/^\[.*\]/); // starts with [timestamp]
  });

  it("GET /log/raw — entries without agent omit parens", async () => {
    await app.request("/log", json({ text: "No agent here" }));
    const res = await app.request("/log/raw?last=1h");
    const text = await res.text();
    expect(text).toContain("No agent here");
    expect(text).not.toContain("()");
  });
});

// --- Auth tests ---

describe("Log Auth", () => {
  let app: Hono;

  beforeEach(async () => {
    const { logRoutes } = await import("../routes.js");
    app = new Hono();
    app.use("/log/*", bearerAuth());
    app.route("/log", logRoutes);
  });

  it("rejects requests without token when auth is configured", async () => {
    const origToken = process.env.VERS_AUTH_TOKEN;
    process.env.VERS_AUTH_TOKEN = "test-secret-token";
    try {
      const res = await app.request("/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(401);

      const getRes = await app.request("/log");
      expect(getRes.status).toBe(401);

      const rawRes = await app.request("/log/raw");
      expect(rawRes.status).toBe(401);
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
      const res = await app.request("/log", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-secret-token",
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
