import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { KBStore } from "../store.js";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";

const TEST_FILE = "data/test-kb-routes.json";

function cleanup() {
  for (const f of [TEST_FILE, TEST_FILE + ".tmp"]) {
    try { unlinkSync(f); } catch {}
  }
}

// Inline route setup to avoid importing from routes.ts (which has side effects)
function createApp() {
  const store = new KBStore(TEST_FILE);
  const app = new Hono();

  app.post("/entries", async (c) => {
    const body = await c.req.json();
    try {
      const entry = store.create(body);
      return c.json(entry, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.get("/entries", (c) => {
    const filters: any = {};
    const type = c.req.query("type");
    const tag = c.req.query("tag");
    const search = c.req.query("search");
    if (type) filters.type = type;
    if (tag) filters.tag = tag;
    if (search) filters.search = search;
    const entries = store.list(filters);
    return c.json({ entries, count: entries.length });
  });

  app.get("/entries/:id", (c) => {
    try {
      const entry = store.get(c.req.param("id"));
      return c.json(entry);
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  app.delete("/entries/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ deleted: true });
  });

  app.get("/briefing", (c) => {
    const format = c.req.query("format");
    const briefing = store.briefing();
    if (format === "text") return c.text(briefing);
    return c.json({ briefing, entryCount: store.size });
  });

  app.get("/stats", (c) => c.json(store.stats()));

  return { app, store };
}

describe("KB Routes", () => {
  let app: Hono;
  let store: KBStore;

  beforeEach(() => {
    cleanup();
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    ({ app, store } = createApp());
  });

  afterEach(() => cleanup());

  it("POST /entries creates an entry", async () => {
    const res = await app.request("/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "lesson",
        title: "Test",
        content: "Test content",
        tags: ["test"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.title).toBe("Test");
  });

  it("POST /entries returns 400 for invalid input", async () => {
    const res = await app.request("/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid", title: "Bad", content: "C" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /entries lists entries with filters", async () => {
    store.create({ type: "lesson", title: "L", content: "C", tags: ["a"] });
    store.create({ type: "gotcha", title: "G", content: "C", tags: ["b"] });

    const res = await app.request("/entries?type=lesson");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.entries[0].type).toBe("lesson");
  });

  it("GET /entries/:id returns entry", async () => {
    const entry = store.create({ type: "sop", title: "S", content: "C" });
    const res = await app.request(`/entries/${entry.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("S");
  });

  it("GET /entries/:id returns 404 for missing", async () => {
    const res = await app.request("/entries/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /entries/:id removes entry", async () => {
    const entry = store.create({ type: "reference", title: "R", content: "C" });
    const res = await app.request(`/entries/${entry.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("GET /briefing returns markdown", async () => {
    store.create({ type: "lesson", title: "Fleet Lesson", content: "Important" });
    const res = await app.request("/briefing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.briefing).toContain("Fleet Knowledge Base");
    expect(body.entryCount).toBe(1);
  });

  it("GET /briefing?format=text returns plain text", async () => {
    store.create({ type: "lesson", title: "Plain", content: "Text" });
    const res = await app.request("/briefing?format=text");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Plain");
  });

  it("GET /stats returns statistics", async () => {
    store.create({ type: "lesson", title: "L", content: "C" });
    const res = await app.request("/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
  });
});
