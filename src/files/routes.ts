import { Hono } from "hono";
import { FileStore } from "./store.js";

export const fileStore = new FileStore();

/** Authenticated file routes (mounted under /files) */
export const fileRoutes = new Hono();

/** Public routes (share links, no auth) */
export const filePublicRoutes = new Hono();

// ── Helpers ──────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  ts: "text/x-typescript",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "tar.gz": "application/gzip",
  log: "text/plain",
};

function guessMime(filename: string): string {
  const lower = filename.toLowerCase();
  // Try double extension first (tar.gz)
  const parts = lower.split(".");
  if (parts.length >= 3) {
    const doubleExt = parts.slice(-2).join(".");
    if (MIME_MAP[doubleExt]) return MIME_MAP[doubleExt];
  }
  const ext = parts.pop() || "";
  return MIME_MAP[ext] || "application/octet-stream";
}

function fileToJson(f: ReturnType<FileStore["getFile"]>) {
  if (!f) return null;
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mimeType: f.mimeType,
    uploader: f.uploader,
    createdAt: f.createdAt,
    downloads: f.downloads,
    url: `/files/download/${f.id}`,
  };
}

// ── POST /files/upload — Multipart file upload ──────────────────────

fileRoutes.post("/upload", async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
    }

    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file found in form data. Use field name "file".' }, 400);
    }

    if (file.size > FileStore.MAX_FILE_SIZE) {
      return c.json({ error: `File exceeds max size of 50MB` }, 413);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const name = file.name || "unnamed";
    const mimeType = file.type || guessMime(name);
    const uploader = formData.get("uploader")?.toString() || null;

    const record = fileStore.saveFile(name, buffer, mimeType, uploader || undefined);
    return c.json(fileToJson(record), 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Upload failed" }, 500);
  }
});

// ── POST /files/upload-url — Base64 body upload ─────────────────────

fileRoutes.post("/upload-url", async (c) => {
  try {
    const body = await c.req.json();
    const { name, content, encoding, uploader } = body;

    if (!name || !content) {
      return c.json({ error: '"name" and "content" are required' }, 400);
    }

    let buffer: Buffer;
    if (encoding === "base64") {
      buffer = Buffer.from(content, "base64");
    } else {
      // Treat as UTF-8 text
      buffer = Buffer.from(content, "utf-8");
    }

    if (buffer.length > FileStore.MAX_FILE_SIZE) {
      return c.json({ error: `File exceeds max size of 50MB` }, 413);
    }

    const mimeType = guessMime(name);
    const record = fileStore.saveFile(name, buffer, mimeType, uploader || undefined);
    return c.json(fileToJson(record), 201);
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    return c.json({ error: err.message || "Upload failed" }, 500);
  }
});

// ── GET /files/download/:id — Serve file ────────────────────────────

fileRoutes.get("/download/:id", (c) => {
  const record = fileStore.getFile(c.req.param("id"));
  if (!record) return c.json({ error: "File not found" }, 404);

  try {
    const data = fileStore.readFileData(record);
    fileStore.recordDownload(record.id);

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": record.mimeType,
        "Content-Disposition": `attachment; filename="${record.name}"`,
        "Content-Length": record.size.toString(),
      },
    });
  } catch {
    return c.json({ error: "File data not found on disk" }, 404);
  }
});

// ── GET /files/list — List all files ────────────────────────────────

fileRoutes.get("/list", (c) => {
  const files = fileStore.listFiles().map(fileToJson);
  return c.json({ files, count: files.length });
});

// ── DELETE /files/:id — Delete a file ───────────────────────────────

fileRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  const deleted = fileStore.deleteFile(id);
  if (!deleted) return c.json({ error: "File not found" }, 404);
  return c.json({ ok: true, deleted: id });
});

// ── POST /files/share/:id — Create share link ──────────────────────

fileRoutes.post("/share/:id", async (c) => {
  const fileId = c.req.param("id");
  try {
    let expiresAt: string | undefined;
    try {
      const body = await c.req.json();
      expiresAt = body.expiresAt;
    } catch {
      // No body — use defaults
    }

    const link = fileStore.createShareLink(fileId, expiresAt);
    return c.json({
      linkId: link.linkId,
      fileId: link.fileId,
      url: `/files/share/${link.linkId}`,
      expiresAt: link.expiresAt,
    }, 201);
  } catch (err: any) {
    if (err.message === "File not found") {
      return c.json({ error: "File not found" }, 404);
    }
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /files/share/:linkId — Public download (no auth) ────────────

filePublicRoutes.get("/files/share/:linkId", (c) => {
  const linkId = c.req.param("linkId");
  const record = fileStore.validateShareLink(linkId);
  if (!record) {
    return c.json({ error: "Share link not found or expired" }, 404);
  }

  try {
    const data = fileStore.readFileData(record);
    fileStore.recordDownload(record.id);

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": record.mimeType,
        "Content-Disposition": `attachment; filename="${record.name}"`,
        "Content-Length": record.size.toString(),
      },
    });
  } catch {
    return c.json({ error: "File data not found on disk" }, 404);
  }
});
