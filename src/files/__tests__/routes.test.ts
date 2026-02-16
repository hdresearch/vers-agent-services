import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { FileStore } from "../store.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "data/test-files-routes";
const TEST_DB = join(TEST_DIR, "test.db");
const TEST_STORAGE = join(TEST_DIR, "storage");

// Build a mini app with the routes inline (to use test store)
function createTestApp() {
  const store = new FileStore(TEST_DB, TEST_STORAGE);
  const app = new Hono();

  // Import route handlers inline with test store
  // We replicate the route structure to test with isolated store

  app.post("/files/upload", async (c) => {
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file found' }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const name = file.name || "unnamed";
    const mimeType = file.type || "application/octet-stream";
    const uploader = formData.get("uploader")?.toString() || undefined;
    const record = store.saveFile(name, buffer, mimeType, uploader);
    return c.json({
      id: record.id, name: record.name, size: record.size,
      url: `/files/download/${record.id}`,
    }, 201);
  });

  app.post("/files/upload-url", async (c) => {
    const body = await c.req.json();
    const { name, content, encoding, uploader } = body;
    if (!name || !content) return c.json({ error: "missing fields" }, 400);
    const buffer = encoding === "base64"
      ? Buffer.from(content, "base64")
      : Buffer.from(content, "utf-8");
    const record = store.saveFile(name, buffer, "application/octet-stream", uploader);
    return c.json({
      id: record.id, name: record.name, size: record.size,
      url: `/files/download/${record.id}`,
    }, 201);
  });

  app.get("/files/download/:id", (c) => {
    const record = store.getFile(c.req.param("id"));
    if (!record) return c.json({ error: "not found" }, 404);
    const data = store.readFileData(record);
    store.recordDownload(record.id);
    return new Response(data, {
      headers: {
        "Content-Type": record.mimeType,
        "Content-Disposition": `attachment; filename="${record.name}"`,
      },
    });
  });

  app.get("/files/list", (c) => {
    const files = store.listFiles();
    return c.json({ files, count: files.length });
  });

  app.delete("/files/:id", (c) => {
    const deleted = store.deleteFile(c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/files/share/:id", async (c) => {
    try {
      const link = store.createShareLink(c.req.param("id"));
      return c.json({ linkId: link.linkId, url: `/files/share/${link.linkId}` }, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  app.get("/files/share/:linkId", (c) => {
    const record = store.validateShareLink(c.req.param("linkId"));
    if (!record) return c.json({ error: "invalid or expired" }, 404);
    const data = store.readFileData(record);
    store.recordDownload(record.id);
    return new Response(data, {
      headers: { "Content-Type": record.mimeType },
    });
  });

  return { app, store };
}

describe("File routes", () => {
  let app: Hono;
  let store: FileStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    const t = createTestApp();
    app = t.app;
    store = t.store;
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("POST /files/upload-url — base64 upload", async () => {
    const content = Buffer.from("hello file sharing!").toString("base64");
    const res = await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test.txt", content, encoding: "base64", uploader: "hermes" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBeTruthy();
    expect(json.name).toBe("test.txt");
    expect(json.size).toBe(19);
    expect(json.url).toContain("/files/download/");
  });

  it("POST /files/upload-url — text upload (no encoding)", async () => {
    const res = await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "data.json", content: '{"key":"value"}' }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.name).toBe("data.json");
  });

  it("GET /files/download/:id — serves file", async () => {
    const content = Buffer.from("download me").toString("base64");
    const uploadRes = await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dl.txt", content, encoding: "base64" }),
    });
    const { id } = await uploadRes.json();

    const res = await app.request(`/files/download/${id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("download me");
    expect(res.headers.get("Content-Disposition")).toContain("dl.txt");
  });

  it("GET /files/download/:id — 404 for missing", async () => {
    const res = await app.request("/files/download/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /files/list — lists uploaded files", async () => {
    await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a.txt", content: "aaa" }),
    });
    await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "b.txt", content: "bbb" }),
    });

    const res = await app.request("/files/list");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
    expect(json.files).toHaveLength(2);
  });

  it("DELETE /files/:id — deletes file", async () => {
    const uploadRes = await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "delete-me.txt", content: "bye" }),
    });
    const { id } = await uploadRes.json();

    const delRes = await app.request(`/files/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request(`/files/download/${id}`);
    expect(getRes.status).toBe(404);
  });

  it("DELETE /files/:id — 404 for missing", async () => {
    const res = await app.request("/files/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /files/share/:id + GET /files/share/:linkId — share flow", async () => {
    const uploadRes = await app.request("/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "shared.txt", content: "shared content" }),
    });
    const { id } = await uploadRes.json();

    const shareRes = await app.request(`/files/share/${id}`, { method: "POST" });
    expect(shareRes.status).toBe(201);
    const shareJson = await shareRes.json();
    expect(shareJson.linkId).toBeTruthy();
    expect(shareJson.url).toContain("/files/share/");

    // Download via share link
    const dlRes = await app.request(shareJson.url);
    expect(dlRes.status).toBe(200);
    const text = await dlRes.text();
    expect(text).toBe("shared content");
  });

  it("GET /files/share/:linkId — 404 for invalid link", async () => {
    const res = await app.request("/files/share/nonexistent");
    expect(res.status).toBe(404);
  });

  it("POST /files/upload — multipart upload", async () => {
    const formData = new FormData();
    const blob = new Blob(["multipart content"], { type: "text/plain" });
    formData.append("file", new File([blob], "multi.txt", { type: "text/plain" }));
    formData.append("uploader", "test-agent");

    const res = await app.request("/files/upload", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.name).toBe("multi.txt");
    expect(json.size).toBe(17);
  });
});
