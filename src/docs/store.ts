/**
 * Docs Registry — SQLite-backed store for collaborative markdown documents.
 *
 * Features:
 *   - Documents with metadata (author, tags, status: draft/review/published)
 *   - Content-addressed versioning (SHA-256 hash per version)
 *   - Threaded inline comments
 *   - Contributor tracking
 *   - Full-text search via SQLite FTS5
 */

import Database from "better-sqlite3";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError, NotFoundError } from "../errors.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type DocStatus = "draft" | "review" | "published";

export interface Doc {
  id: string;
  title: string;
  author: string;
  content: string;
  status: DocStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  currentVersionId: string;
  currentHash: string;
}

export interface DocVersion {
  id: string;
  docId: string;
  content: string;
  hash: string;
  author: string;
  message: string;
  createdAt: string;
  versionNumber: number;
}

export interface DocComment {
  id: string;
  docId: string;
  author: string;
  content: string;
  lineRef: string | null;       // optional line/section reference
  parentCommentId: string | null; // for threading
  createdAt: string;
  updatedAt: string;
}

export interface Contributor {
  docId: string;
  author: string;
  edits: number;
  firstEditAt: string;
  lastEditAt: string;
}

export interface CreateDocInput {
  title: string;
  author: string;
  content: string;
  status?: DocStatus;
  tags?: string[];
}

export interface UpdateDocInput {
  title?: string;
  content?: string;
  status?: DocStatus;
  tags?: string[];
  author: string;          // who is making this edit
  message?: string;        // version commit message
}

export interface CreateCommentInput {
  author: string;
  content: string;
  lineRef?: string;
  parentCommentId?: string;
}

export interface DocFilters {
  status?: DocStatus;
  author?: string;
  tag?: string;
  search?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_STATUSES: Set<string> = new Set(["draft", "review", "published"]);

function validateStatus(s: unknown): DocStatus {
  if (!s) return "draft";
  if (!VALID_STATUSES.has(String(s))) {
    throw new ValidationError("status must be one of: draft, review, published");
  }
  return String(s) as DocStatus;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Store ──────────────────────────────────────────────────────────────────

export class DocsStore {
  private db: Database.Database;

  constructor(dbPath = "data/docs.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        current_version_id TEXT NOT NULL,
        current_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
      CREATE INDEX IF NOT EXISTS idx_docs_author ON docs(author);

      CREATE TABLE IF NOT EXISTS doc_versions (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        author TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(doc_id);
      CREATE INDEX IF NOT EXISTS idx_versions_hash ON doc_versions(hash);

      CREATE TABLE IF NOT EXISTS doc_comments (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        line_ref TEXT,
        parent_comment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_comments_doc ON doc_comments(doc_id);

      CREATE TABLE IF NOT EXISTS doc_contributors (
        doc_id TEXT NOT NULL,
        author TEXT NOT NULL,
        edits INTEGER NOT NULL DEFAULT 1,
        first_edit_at TEXT NOT NULL,
        last_edit_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, author),
        FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
      );

      -- Full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        title, content, author, tags,
        content='docs',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, title, content, author, tags)
        VALUES (NEW.rowid, NEW.title, NEW.content, NEW.author, NEW.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, content, author, tags)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.author, OLD.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, content, author, tags)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.author, OLD.tags);
        INSERT INTO docs_fts(rowid, title, content, author, tags)
        VALUES (NEW.rowid, NEW.title, NEW.content, NEW.author, NEW.tags);
      END;
    `);
  }

  // ── Documents ────────────────────────────────────────────────────────────

  create(input: CreateDocInput): Doc {
    if (!input.title?.trim()) throw new ValidationError("title is required");
    if (!input.author?.trim()) throw new ValidationError("author is required");
    if (input.content == null) throw new ValidationError("content is required");

    const status = validateStatus(input.status);
    const tags = input.tags || [];
    const now = new Date().toISOString();
    const id = ulid();
    const versionId = ulid();
    const hash = contentHash(input.content);

    const insertDoc = this.db.prepare(`
      INSERT INTO docs (id, title, author, content, status, tags, created_at, updated_at, current_version_id, current_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVersion = this.db.prepare(`
      INSERT INTO doc_versions (id, doc_id, content, hash, author, message, created_at, version_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertContributor = this.db.prepare(`
      INSERT INTO doc_contributors (doc_id, author, edits, first_edit_at, last_edit_at)
      VALUES (?, ?, 1, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      insertDoc.run(id, input.title.trim(), input.author.trim(), input.content, status, JSON.stringify(tags), now, now, versionId, hash);
      insertVersion.run(versionId, id, input.content, hash, input.author.trim(), "Initial version", now, 1);
      insertContributor.run(id, input.author.trim(), now, now);
    });
    tx();

    return {
      id, title: input.title.trim(), author: input.author.trim(),
      content: input.content, status, tags,
      createdAt: now, updatedAt: now,
      currentVersionId: versionId, currentHash: hash,
    };
  }

  get(id: string): Doc {
    const row = this.db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as any;
    if (!row) throw new NotFoundError("document not found");
    return this.rowToDoc(row);
  }

  list(filters?: DocFilters): Doc[] {
    let sql = "SELECT * FROM docs WHERE 1=1";
    const params: any[] = [];

    if (filters?.status) {
      validateStatus(filters.status);
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.author) {
      sql += " AND author = ?";
      params.push(filters.author);
    }
    if (filters?.tag) {
      sql += " AND tags LIKE ?";
      params.push(`%"${filters.tag}"%`);
    }

    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToDoc(r));
  }

  search(query: string): Doc[] {
    if (!query?.trim()) return [];
    // Use FTS5 match; join back to docs for full row
    const rows = this.db.prepare(`
      SELECT docs.* FROM docs_fts
      JOIN docs ON docs.rowid = docs_fts.rowid
      WHERE docs_fts MATCH ?
      ORDER BY rank
    `).all(query.trim()) as any[];
    return rows.map((r) => this.rowToDoc(r));
  }

  update(id: string, input: UpdateDocInput): Doc {
    if (!input.author?.trim()) throw new ValidationError("author is required for updates");

    const existing = this.get(id); // throws NotFoundError
    const now = new Date().toISOString();

    const newTitle = input.title?.trim() || existing.title;
    const newStatus = input.status ? validateStatus(input.status) : existing.status;
    const newTags = input.tags ?? existing.tags;
    const newContent = input.content ?? existing.content;
    const hash = contentHash(newContent);
    const message = input.message || "";

    // Only create a new version if content actually changed
    const contentChanged = hash !== existing.currentHash;
    let versionId = existing.currentVersionId;

    const tx = this.db.transaction(() => {
      if (contentChanged) {
        // Get next version number
        const maxRow = this.db.prepare(
          "SELECT COALESCE(MAX(version_number), 0) as max_v FROM doc_versions WHERE doc_id = ?"
        ).get(id) as any;
        const nextVersion = maxRow.max_v + 1;
        versionId = ulid();

        this.db.prepare(`
          INSERT INTO doc_versions (id, doc_id, content, hash, author, message, created_at, version_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(versionId, id, newContent, hash, input.author.trim(), message, now, nextVersion);

        // Upsert contributor
        this.db.prepare(`
          INSERT INTO doc_contributors (doc_id, author, edits, first_edit_at, last_edit_at)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(doc_id, author) DO UPDATE SET
            edits = edits + 1,
            last_edit_at = excluded.last_edit_at
        `).run(id, input.author.trim(), now, now);
      }

      this.db.prepare(`
        UPDATE docs SET title = ?, content = ?, status = ?, tags = ?,
          updated_at = ?, current_version_id = ?, current_hash = ?
        WHERE id = ?
      `).run(newTitle, newContent, newStatus, JSON.stringify(newTags), now, versionId, hash, id);
    });
    tx();

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  getVersions(docId: string): DocVersion[] {
    // Ensure doc exists
    this.get(docId);
    const rows = this.db.prepare(
      "SELECT * FROM doc_versions WHERE doc_id = ? ORDER BY version_number DESC"
    ).all(docId) as any[];
    return rows.map((r) => this.rowToVersion(r));
  }

  getVersion(docId: string, versionId: string): DocVersion {
    const row = this.db.prepare(
      "SELECT * FROM doc_versions WHERE doc_id = ? AND id = ?"
    ).get(docId, versionId) as any;
    if (!row) throw new NotFoundError("version not found");
    return this.rowToVersion(row);
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  addComment(docId: string, input: CreateCommentInput): DocComment {
    // Ensure doc exists
    this.get(docId);

    if (!input.author?.trim()) throw new ValidationError("author is required");
    if (!input.content?.trim()) throw new ValidationError("content is required");

    if (input.parentCommentId) {
      const parent = this.db.prepare(
        "SELECT id FROM doc_comments WHERE id = ? AND doc_id = ?"
      ).get(input.parentCommentId, docId) as any;
      if (!parent) throw new NotFoundError("parent comment not found");
    }

    const now = new Date().toISOString();
    const id = ulid();

    this.db.prepare(`
      INSERT INTO doc_comments (id, doc_id, author, content, line_ref, parent_comment_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, docId, input.author.trim(), input.content.trim(), input.lineRef || null, input.parentCommentId || null, now, now);

    return {
      id, docId, author: input.author.trim(),
      content: input.content.trim(),
      lineRef: input.lineRef || null,
      parentCommentId: input.parentCommentId || null,
      createdAt: now, updatedAt: now,
    };
  }

  getComments(docId: string): DocComment[] {
    // Ensure doc exists
    this.get(docId);
    const rows = this.db.prepare(
      "SELECT * FROM doc_comments WHERE doc_id = ? ORDER BY created_at ASC"
    ).all(docId) as any[];
    return rows.map((r) => this.rowToComment(r));
  }

  // ── Contributors ─────────────────────────────────────────────────────────

  getContributors(docId: string): Contributor[] {
    this.get(docId);
    const rows = this.db.prepare(
      "SELECT * FROM doc_contributors WHERE doc_id = ? ORDER BY edits DESC"
    ).all(docId) as any[];
    return rows.map((r) => ({
      docId: r.doc_id,
      author: r.author,
      edits: r.edits,
      firstEditAt: r.first_edit_at,
      lastEditAt: r.last_edit_at,
    }));
  }

  // ── Public access ────────────────────────────────────────────────────────

  listPublished(filters?: { tag?: string; search?: string }): Doc[] {
    if (filters?.search) {
      const rows = this.db.prepare(`
        SELECT docs.* FROM docs_fts
        JOIN docs ON docs.rowid = docs_fts.rowid
        WHERE docs_fts MATCH ? AND docs.status = 'published'
        ORDER BY rank
      `).all(filters.search.trim()) as any[];
      return rows.map((r) => this.rowToDoc(r));
    }

    let sql = "SELECT * FROM docs WHERE status = 'published'";
    const params: any[] = [];
    if (filters?.tag) {
      sql += " AND tags LIKE ?";
      params.push(`%"${filters.tag}"%`);
    }
    sql += " ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToDoc(r));
  }

  getPublished(id: string): Doc {
    const row = this.db.prepare(
      "SELECT * FROM docs WHERE id = ? AND status = 'published'"
    ).get(id) as any;
    if (!row) throw new NotFoundError("published document not found");
    return this.rowToDoc(row);
  }

  // ── Row mappers ──────────────────────────────────────────────────────────

  private rowToDoc(row: any): Doc {
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      content: row.content,
      status: row.status as DocStatus,
      tags: JSON.parse(row.tags || "[]"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentVersionId: row.current_version_id,
      currentHash: row.current_hash,
    };
  }

  private rowToVersion(row: any): DocVersion {
    return {
      id: row.id,
      docId: row.doc_id,
      content: row.content,
      hash: row.hash,
      author: row.author,
      message: row.message,
      createdAt: row.created_at,
      versionNumber: row.version_number,
    };
  }

  private rowToComment(row: any): DocComment {
    return {
      id: row.id,
      docId: row.doc_id,
      author: row.author,
      content: row.content,
      lineRef: row.line_ref,
      parentCommentId: row.parent_comment_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

export { NotFoundError, ValidationError };
