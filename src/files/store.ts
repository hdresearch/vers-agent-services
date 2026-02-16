import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";

export interface FileRecord {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  uploader: string | null;
  createdAt: string;
  downloads: number;
  storagePath: string;
}

export interface ShareLink {
  linkId: string;
  fileId: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: number;
}

export class FileStore {
  private db: Database.Database;
  private storageDir: string;

  static MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  static DEFAULT_SHARE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(dbPath = "data/files.db", storageDir = "data/files") {
    // Ensure dirs exist
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true });

    this.storageDir = storageDir;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mimeType TEXT NOT NULL DEFAULT 'application/octet-stream',
        uploader TEXT,
        createdAt TEXT NOT NULL,
        downloads INTEGER DEFAULT 0,
        storagePath TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_shares (
        linkId TEXT PRIMARY KEY,
        fileId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT,
        revoked INTEGER DEFAULT 0,
        FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_shares_fileId ON file_shares(fileId);
    `);
  }

  /** Store a file from a Buffer */
  saveFile(name: string, data: Buffer, mimeType: string, uploader?: string): FileRecord {
    if (data.length > FileStore.MAX_FILE_SIZE) {
      throw new Error(`File exceeds max size of ${FileStore.MAX_FILE_SIZE} bytes`);
    }

    const id = randomUUID();
    // Preserve extension from original name
    const ext = name.includes(".") ? "." + name.split(".").pop() : "";
    const storageName = id + ext;
    const storagePath = join(this.storageDir, storageName);

    writeFileSync(storagePath, data);

    const record: FileRecord = {
      id,
      name,
      size: data.length,
      mimeType,
      uploader: uploader || null,
      createdAt: new Date().toISOString(),
      downloads: 0,
      storagePath,
    };

    this.db
      .prepare(
        `INSERT INTO files (id, name, size, mimeType, uploader, createdAt, downloads, storagePath)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(record.id, record.name, record.size, record.mimeType, record.uploader, record.createdAt, record.downloads, record.storagePath);

    return record;
  }

  getFile(id: string): FileRecord | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRecord | undefined;
  }

  /** Read file data from disk */
  readFileData(record: FileRecord): Buffer {
    return readFileSync(record.storagePath);
  }

  /** Increment download counter */
  recordDownload(id: string): void {
    this.db.prepare("UPDATE files SET downloads = downloads + 1 WHERE id = ?").run(id);
  }

  listFiles(): FileRecord[] {
    return this.db.prepare("SELECT * FROM files ORDER BY createdAt DESC").all() as FileRecord[];
  }

  deleteFile(id: string): boolean {
    const record = this.getFile(id);
    if (!record) return false;

    const tx = this.db.transaction(() => {
      // Delete share links
      this.db.prepare("DELETE FROM file_shares WHERE fileId = ?").run(id);
      // Delete DB record
      this.db.prepare("DELETE FROM files WHERE id = ?").run(id);
    });
    tx();

    // Delete file from disk
    try {
      if (existsSync(record.storagePath)) unlinkSync(record.storagePath);
    } catch {
      // File already gone — fine
    }

    return true;
  }

  /** Create a public share link */
  createShareLink(fileId: string, expiresAt?: string): ShareLink {
    const file = this.getFile(fileId);
    if (!file) throw new Error("File not found");

    const now = new Date();
    const defaultExpiry = new Date(now.getTime() + FileStore.DEFAULT_SHARE_EXPIRY_MS).toISOString();

    const link: ShareLink = {
      linkId: randomUUID(),
      fileId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt || defaultExpiry,
      revoked: 0,
    };

    this.db
      .prepare(
        `INSERT INTO file_shares (linkId, fileId, createdAt, expiresAt, revoked)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(link.linkId, link.fileId, link.createdAt, link.expiresAt, link.revoked);

    return link;
  }

  /** Validate a share link — returns file if valid */
  validateShareLink(linkId: string): FileRecord | null {
    const link = this.db.prepare("SELECT * FROM file_shares WHERE linkId = ?").get(linkId) as ShareLink | undefined;
    if (!link) return null;
    if (link.revoked) return null;
    if (link.expiresAt && new Date(link.expiresAt) < new Date()) return null;

    const file = this.getFile(link.fileId);
    return file || null;
  }

  /** Get share links for a file */
  getShareLinks(fileId: string): ShareLink[] {
    return this.db.prepare("SELECT * FROM file_shares WHERE fileId = ? ORDER BY createdAt DESC").all(fileId) as ShareLink[];
  }

  /** Revoke a share link */
  revokeShareLink(linkId: string): boolean {
    const result = this.db.prepare("UPDATE file_shares SET revoked = 1 WHERE linkId = ? AND revoked = 0").run(linkId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
