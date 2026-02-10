import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface ShareLink {
  linkId: string;
  reportId: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  label: string | null;
  revoked: number;
}

export interface ShareLinkWithCount extends ShareLink {
  accessCount: number;
}

export interface CreateShareLinkInput {
  reportId: string;
  createdBy: string;
  expiresAt?: string;
  label?: string;
}

export interface AccessLogEntry {
  id: string;
  linkId: string;
  reportId: string;
  timestamp: string;
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
}

export class ShareStore {
  private db: Database.Database;

  constructor(dbPath = "data/reports.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS share_links (
        linkId TEXT PRIMARY KEY,
        reportId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        expiresAt TEXT,
        label TEXT,
        revoked INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_share_links_reportId ON share_links(reportId);

      CREATE TABLE IF NOT EXISTS share_access_log (
        id TEXT PRIMARY KEY,
        linkId TEXT NOT NULL,
        reportId TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        ip TEXT,
        userAgent TEXT,
        referrer TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_access_log_linkId ON share_access_log(linkId);
    `);
  }

  createLink(input: CreateShareLinkInput): ShareLink {
    const link: ShareLink = {
      linkId: ulid(),
      reportId: input.reportId,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      expiresAt: input.expiresAt || null,
      label: input.label || null,
      revoked: 0,
    };

    this.db
      .prepare(
        `INSERT INTO share_links (linkId, reportId, createdAt, createdBy, expiresAt, label, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        link.linkId,
        link.reportId,
        link.createdAt,
        link.createdBy,
        link.expiresAt,
        link.label,
        link.revoked
      );

    return link;
  }

  getLink(linkId: string): ShareLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM share_links WHERE linkId = ?")
      .get(linkId) as ShareLink | undefined;
    return row;
  }

  listLinksForReport(reportId: string): ShareLinkWithCount[] {
    const rows = this.db
      .prepare(
        `SELECT sl.*, COUNT(sal.id) as accessCount
         FROM share_links sl
         LEFT JOIN share_access_log sal ON sl.linkId = sal.linkId
         WHERE sl.reportId = ?
         GROUP BY sl.linkId
         ORDER BY sl.createdAt DESC`
      )
      .all(reportId) as ShareLinkWithCount[];
    return rows;
  }

  revokeLink(linkId: string): boolean {
    const result = this.db
      .prepare("UPDATE share_links SET revoked = 1 WHERE linkId = ? AND revoked = 0")
      .run(linkId);
    return result.changes > 0;
  }

  /**
   * Validates a share link for public access.
   * Returns the link if valid, or null if not found / revoked / expired.
   */
  validateLink(linkId: string): ShareLink | null {
    const link = this.getLink(linkId);
    if (!link) return null;
    if (link.revoked) return null;
    if (link.expiresAt && new Date(link.expiresAt) < new Date()) return null;
    return link;
  }

  recordAccess(linkId: string, reportId: string, info: { ip?: string; userAgent?: string; referrer?: string }): AccessLogEntry {
    const entry: AccessLogEntry = {
      id: ulid(),
      linkId,
      reportId,
      timestamp: new Date().toISOString(),
      ip: info.ip || null,
      userAgent: info.userAgent || null,
      referrer: info.referrer || null,
    };

    this.db
      .prepare(
        `INSERT INTO share_access_log (id, linkId, reportId, timestamp, ip, userAgent, referrer)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(entry.id, entry.linkId, entry.reportId, entry.timestamp, entry.ip, entry.userAgent, entry.referrer);

    return entry;
  }

  getAccessLog(linkId: string): AccessLogEntry[] {
    return this.db
      .prepare("SELECT * FROM share_access_log WHERE linkId = ? ORDER BY timestamp DESC")
      .all(linkId) as AccessLogEntry[];
  }

  close(): void {
    this.db.close();
  }
}
