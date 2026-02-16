import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../store.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "data/test-files-store";
const TEST_DB = join(TEST_DIR, "test.db");
const TEST_STORAGE = join(TEST_DIR, "storage");

describe("FileStore", () => {
  let store: FileStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new FileStore(TEST_DB, TEST_STORAGE);
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("saves and retrieves a file", () => {
    const data = Buffer.from("hello world");
    const record = store.saveFile("test.txt", data, "text/plain", "agent-1");

    expect(record.id).toBeTruthy();
    expect(record.name).toBe("test.txt");
    expect(record.size).toBe(11);
    expect(record.mimeType).toBe("text/plain");
    expect(record.uploader).toBe("agent-1");
    expect(record.downloads).toBe(0);

    const retrieved = store.getFile(record.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("test.txt");

    const fileData = store.readFileData(retrieved!);
    expect(fileData.toString()).toBe("hello world");
  });

  it("lists files", () => {
    store.saveFile("a.txt", Buffer.from("aaa"), "text/plain");
    store.saveFile("b.json", Buffer.from("{}"), "application/json");

    const files = store.listFiles();
    expect(files).toHaveLength(2);
    const names = files.map(f => f.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.json");
  });

  it("deletes a file", () => {
    const record = store.saveFile("del.txt", Buffer.from("bye"), "text/plain");
    expect(existsSync(record.storagePath)).toBe(true);

    const deleted = store.deleteFile(record.id);
    expect(deleted).toBe(true);
    expect(store.getFile(record.id)).toBeUndefined();
    expect(existsSync(record.storagePath)).toBe(false);
  });

  it("returns false for deleting non-existent file", () => {
    expect(store.deleteFile("nonexistent")).toBe(false);
  });

  it("tracks download count", () => {
    const record = store.saveFile("dl.txt", Buffer.from("data"), "text/plain");
    store.recordDownload(record.id);
    store.recordDownload(record.id);
    store.recordDownload(record.id);

    const updated = store.getFile(record.id);
    expect(updated!.downloads).toBe(3);
  });

  it("rejects files exceeding max size", () => {
    // We won't actually allocate 50MB — just test the check
    const originalMax = FileStore.MAX_FILE_SIZE;
    (FileStore as any).MAX_FILE_SIZE = 10;

    expect(() => {
      store.saveFile("big.bin", Buffer.alloc(11), "application/octet-stream");
    }).toThrow("exceeds max size");

    (FileStore as any).MAX_FILE_SIZE = originalMax;
  });

  describe("share links", () => {
    it("creates and validates a share link", () => {
      const record = store.saveFile("shared.txt", Buffer.from("secret"), "text/plain");
      const link = store.createShareLink(record.id);

      expect(link.linkId).toBeTruthy();
      expect(link.fileId).toBe(record.id);
      expect(link.expiresAt).toBeTruthy();

      const file = store.validateShareLink(link.linkId);
      expect(file).toBeTruthy();
      expect(file!.id).toBe(record.id);
    });

    it("rejects expired share links", () => {
      const record = store.saveFile("exp.txt", Buffer.from("data"), "text/plain");
      const pastDate = new Date(Date.now() - 1000).toISOString();
      const link = store.createShareLink(record.id, pastDate);

      const file = store.validateShareLink(link.linkId);
      expect(file).toBeNull();
    });

    it("rejects revoked share links", () => {
      const record = store.saveFile("rev.txt", Buffer.from("data"), "text/plain");
      const link = store.createShareLink(record.id);

      store.revokeShareLink(link.linkId);
      const file = store.validateShareLink(link.linkId);
      expect(file).toBeNull();
    });

    it("throws for non-existent file", () => {
      expect(() => store.createShareLink("nonexistent")).toThrow("File not found");
    });

    it("lists share links for a file", () => {
      const record = store.saveFile("multi.txt", Buffer.from("data"), "text/plain");
      store.createShareLink(record.id);
      store.createShareLink(record.id);

      const links = store.getShareLinks(record.id);
      expect(links).toHaveLength(2);
    });

    it("deleting file cascades to share links", () => {
      const record = store.saveFile("cascade.txt", Buffer.from("data"), "text/plain");
      const link = store.createShareLink(record.id);
      store.deleteFile(record.id);

      const file = store.validateShareLink(link.linkId);
      expect(file).toBeNull();
    });
  });
});
