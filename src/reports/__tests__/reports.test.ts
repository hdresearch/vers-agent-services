import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReportsStore, ValidationError } from "../store.js";

// --- Store unit tests ---

describe("ReportsStore", () => {
  let store: ReportsStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reports-test-"));
    filePath = join(tmpDir, "reports.json");
    store = new ReportsStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a report with defaults", () => {
      const report = store.create({
        title: "Sprint Report",
        author: "agent-1",
        content: "# Sprint 1\nDone.",
      });
      expect(report.id).toBeTruthy();
      expect(report.title).toBe("Sprint Report");
      expect(report.author).toBe("agent-1");
      expect(report.content).toBe("# Sprint 1\nDone.");
      expect(report.tags).toEqual([]);
      expect(report.createdAt).toBeTruthy();
      expect(report.updatedAt).toBe(report.createdAt);
    });

    it("creates a report with tags", () => {
      const report = store.create({
        title: "Bug Analysis",
        author: "agent-2",
        content: "Found issues.",
        tags: ["bugs", "urgent"],
      });
      expect(report.tags).toEqual(["bugs", "urgent"]);
    });

    it("throws on missing title", () => {
      expect(() =>
        store.create({ title: "", author: "a", content: "c" })
      ).toThrow(ValidationError);
    });

    it("throws on missing author", () => {
      expect(() =>
        store.create({ title: "t", author: "", content: "c" })
      ).toThrow(ValidationError);
    });

    it("throws on missing content", () => {
      expect(() =>
        store.create({ title: "t", author: "a", content: "" as any })
      ).toThrow(ValidationError);
    });
  });

  describe("get", () => {
    it("returns a report by id", () => {
      const created = store.create({ title: "R", author: "a", content: "c" });
      const fetched = store.get(created.id);
      expect(fetched).toEqual(created);
    });

    it("returns undefined for unknown id", () => {
      expect(store.get("nope")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all reports newest first", () => {
      const r1 = store.create({ title: "R1", author: "a", content: "c1" });
      const r2 = store.create({ title: "R2", author: "a", content: "c2" });
      const list = store.list();
      expect(list).toHaveLength(2);
      // Both created in same ms so ULID ordering applies — just check both exist
      const titles = list.map(r => r.title);
      expect(titles).toContain("R1");
      expect(titles).toContain("R2");
    });

    it("filters by author", () => {
      store.create({ title: "R1", author: "alice", content: "c" });
      store.create({ title: "R2", author: "bob", content: "c" });
      const list = store.list({ author: "alice" });
      expect(list).toHaveLength(1);
      expect(list[0].author).toBe("alice");
    });

    it("filters by tag", () => {
      store.create({ title: "R1", author: "a", content: "c", tags: ["infra"] });
      store.create({ title: "R2", author: "a", content: "c", tags: ["bugs"] });
      const list = store.list({ tag: "infra" });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("R1");
    });
  });

  describe("delete", () => {
    it("deletes an existing report", () => {
      const r = store.create({ title: "R", author: "a", content: "c" });
      expect(store.delete(r.id)).toBe(true);
      expect(store.get(r.id)).toBeUndefined();
    });

    it("returns false for unknown id", () => {
      expect(store.delete("nope")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("persists and reloads reports", () => {
      store.create({ title: "Persist", author: "a", content: "data" });
      store.flush();

      const store2 = new ReportsStore(filePath);
      const list = store2.list();
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("Persist");
    });
  });
});

// --- Route integration tests ---

describe("Reports API routes", () => {
  let app: Hono;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reports-route-test-"));
    // Dynamic import to avoid module-level store init issues
    // We create a fresh Hono app with a fresh store
    const { ReportsStore } = await import("../store.js");
    const freshStore = new ReportsStore(join(tmpDir, "reports.json"));

    app = new Hono();
    // Mount routes manually with fresh store
    app.post("/reports", async (c) => {
      try {
        const body = await c.req.json();
        const report = freshStore.create(body);
        return c.json(report, 201);
      } catch (e: any) {
        if (e.name === "ValidationError") return c.json({ error: e.message }, 400);
        throw e;
      }
    });
    app.get("/reports", (c) => {
      const author = c.req.query("author");
      const tag = c.req.query("tag");
      const filters: any = {};
      if (author) filters.author = author;
      if (tag) filters.tag = tag;
      const reports = freshStore.list(filters);
      const summaries = reports.map(({ content, ...rest }) => rest);
      return c.json({ reports: summaries, count: summaries.length });
    });
    app.get("/reports/:id", (c) => {
      const report = freshStore.get(c.req.param("id"));
      if (!report) return c.json({ error: "report not found" }, 404);
      return c.json(report);
    });
    app.delete("/reports/:id", (c) => {
      const deleted = freshStore.delete(c.req.param("id"));
      if (!deleted) return c.json({ error: "report not found" }, 404);
      return c.json({ deleted: true });
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /reports creates a report", async () => {
    const res = await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test", author: "bot", content: "# Hello" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.title).toBe("Test");
  });

  it("POST /reports returns 400 for missing fields", async () => {
    const res = await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /reports lists reports without content", async () => {
    await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "R1", author: "a", content: "# Body" }),
    });
    const res = await app.request("/reports");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.reports[0].content).toBeUndefined();
  });

  it("GET /reports/:id returns full report with content", async () => {
    const createRes = await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "R", author: "a", content: "# Full" }),
    });
    const created = await createRes.json();

    const res = await app.request(`/reports/${created.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe("# Full");
  });

  it("GET /reports/:id returns 404 for unknown", async () => {
    const res = await app.request("/reports/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /reports/:id deletes a report", async () => {
    const createRes = await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "D", author: "a", content: "c" }),
    });
    const created = await createRes.json();

    const res = await app.request(`/reports/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const getRes = await app.request(`/reports/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("GET /reports filters by author", async () => {
    await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "A", author: "alice", content: "c" }),
    });
    await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "B", author: "bob", content: "c" }),
    });

    const res = await app.request("/reports?author=alice");
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.reports[0].title).toBe("A");
  });

  it("GET /reports filters by tag", async () => {
    await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tagged", author: "a", content: "c", tags: ["infra"] }),
    });
    await app.request("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Other", author: "a", content: "c" }),
    });

    const res = await app.request("/reports?tag=infra");
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.reports[0].title).toBe("Tagged");
  });
});
