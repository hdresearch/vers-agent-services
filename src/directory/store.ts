import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError, NotFoundError } from "../errors.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type PersonType = "human" | "fleet" | "org";
export type TrustLevel = "unknown" | "acquaintance" | "trusted" | "close";

export interface Note {
  id: string;
  content: string;
  author: string;
  timestamp: string;
  source: string;
}

export interface FleetIdentity {
  name: string;
  endpoint: string;
  publicKey: string;
  channelId?: string;
}

export type PublicKeyType = "ssh-ed25519" | "ssh-rsa" | "age" | "gpg" | "other";

export interface PublicKey {
  id: string;
  type: PublicKeyType;
  key: string;
  fingerprint?: string;
  label?: string;
  discoveredFrom?: string;
  addedAt: string;
}

export interface AddPublicKeyInput {
  type: PublicKeyType;
  key: string;
  fingerprint?: string;
  label?: string;
  discoveredFrom?: string;
}

export interface Person {
  id: string;
  name: string;
  aliases: string[];
  type: PersonType;

  // Relationship
  relationship: string;
  trustLevel: TrustLevel;
  firstContact: string;
  lastContact: string;

  // What we know
  notes: Note[];
  publicKeys: PublicKey[];

  // Links to other systems
  fleetIdentity?: FleetIdentity;
  github?: string;
  email?: string;

  // Context
  tags: string[];
  projects: string[];

  // Metadata
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface CreatePersonInput {
  name: string;
  aliases?: string[];
  type?: PersonType;
  relationship?: string;
  trustLevel?: TrustLevel;
  firstContact?: string;
  lastContact?: string;
  notes?: Array<Omit<Note, "id" | "timestamp">>;
  fleetIdentity?: FleetIdentity;
  github?: string;
  email?: string;
  tags?: string[];
  projects?: string[];
  createdBy?: string;
}

export interface UpdatePersonInput {
  name?: string;
  aliases?: string[];
  type?: PersonType;
  relationship?: string;
  trustLevel?: TrustLevel;
  firstContact?: string;
  lastContact?: string;
  fleetIdentity?: FleetIdentity | null;
  github?: string | null;
  email?: string | null;
  tags?: string[];
  projects?: string[];
}

export interface AddNoteInput {
  content: string;
  author: string;
  source?: string;
}

export interface GraphNode {
  id: string;
  name: string;
  type: PersonType;
  trustLevel: TrustLevel;
}

export interface GraphEdge {
  from: string;
  to: string;
  relationship: string;
}

export interface RelationshipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Validation ─────────────────────────────────────────────────────────────

const VALID_TYPES: Set<string> = new Set(["human", "fleet", "org"]);
const VALID_TRUST: Set<string> = new Set(["unknown", "acquaintance", "trusted", "close"]);

function validateType(t: unknown): PersonType {
  if (!t) return "human";
  if (!VALID_TYPES.has(String(t))) {
    throw new ValidationError(`Invalid type. Must be one of: human, fleet, org`);
  }
  return String(t) as PersonType;
}

function validateTrust(t: unknown): TrustLevel {
  if (!t) return "unknown";
  if (!VALID_TRUST.has(String(t))) {
    throw new ValidationError(`Invalid trustLevel. Must be one of: unknown, acquaintance, trusted, close`);
  }
  return String(t) as TrustLevel;
}

// ── Store ──────────────────────────────────────────────────────────────────

export class DirectoryStore {
  private db: Database.Database;

  constructor(dbPath = "data/directory.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        type TEXT NOT NULL DEFAULT 'human',
        relationship TEXT NOT NULL DEFAULT '',
        trustLevel TEXT NOT NULL DEFAULT 'unknown',
        firstContact TEXT NOT NULL,
        lastContact TEXT NOT NULL,
        fleetIdentity TEXT,
        github TEXT,
        email TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        projects TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        createdBy TEXT NOT NULL DEFAULT 'system'
      );

      CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
      CREATE INDEX IF NOT EXISTS idx_people_type ON people(type);
      CREATE INDEX IF NOT EXISTS idx_people_trustLevel ON people(trustLevel);

      CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
        name, aliases, relationship, tags, projects, github, email,
        content='people',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS people_ai AFTER INSERT ON people BEGIN
        INSERT INTO people_fts(rowid, name, aliases, relationship, tags, projects, github, email)
        VALUES (new.rowid, new.name, new.aliases, new.relationship, new.tags, new.projects, new.github, new.email);
      END;

      CREATE TRIGGER IF NOT EXISTS people_ad AFTER DELETE ON people BEGIN
        INSERT INTO people_fts(people_fts, rowid, name, aliases, relationship, tags, projects, github, email)
        VALUES ('delete', old.rowid, old.name, old.aliases, old.relationship, old.tags, old.projects, old.github, old.email);
      END;

      CREATE TRIGGER IF NOT EXISTS people_au AFTER UPDATE ON people BEGIN
        INSERT INTO people_fts(people_fts, rowid, name, aliases, relationship, tags, projects, github, email)
        VALUES ('delete', old.rowid, old.name, old.aliases, old.relationship, old.tags, old.projects, old.github, old.email);
        INSERT INTO people_fts(rowid, name, aliases, relationship, tags, projects, github, email)
        VALUES (new.rowid, new.name, new.aliases, new.relationship, new.tags, new.projects, new.github, new.email);
      END;

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        personId TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        FOREIGN KEY (personId) REFERENCES people(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_notes_personId ON notes(personId);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        content, author, source,
        content='notes',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, content, author, source)
        VALUES (new.rowid, new.content, new.author, new.source);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content, author, source)
        VALUES ('delete', old.rowid, old.content, old.author, old.source);
      END;

      -- Relationships between people (who knows who)
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        fromId TEXT NOT NULL,
        toId TEXT NOT NULL,
        relationship TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (fromId) REFERENCES people(id) ON DELETE CASCADE,
        FOREIGN KEY (toId) REFERENCES people(id) ON DELETE CASCADE,
        UNIQUE(fromId, toId)
      );

      CREATE INDEX IF NOT EXISTS idx_relationships_fromId ON relationships(fromId);
      CREATE INDEX IF NOT EXISTS idx_relationships_toId ON relationships(toId);

      CREATE TABLE IF NOT EXISTS public_keys (
        id TEXT PRIMARY KEY,
        personId TEXT NOT NULL,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT,
        label TEXT,
        discoveredFrom TEXT,
        addedAt TEXT NOT NULL,
        FOREIGN KEY (personId) REFERENCES people(id) ON DELETE CASCADE,
        UNIQUE(personId, key)
      );

      CREATE INDEX IF NOT EXISTS idx_public_keys_personId ON public_keys(personId);
    `);
  }

  // ── Person CRUD ──────────────────────────────────────────────────────────

  create(input: CreatePersonInput): Person {
    if (!input.name?.trim()) {
      throw new ValidationError("name is required");
    }

    const type = validateType(input.type);
    const trustLevel = validateTrust(input.trustLevel);
    const now = new Date().toISOString();
    const id = ulid();

    this.db
      .prepare(
        `INSERT INTO people (id, name, aliases, type, relationship, trustLevel, firstContact, lastContact,
         fleetIdentity, github, email, tags, projects, createdAt, updatedAt, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name.trim(),
        JSON.stringify(input.aliases || []),
        type,
        input.relationship?.trim() || "",
        trustLevel,
        input.firstContact || now,
        input.lastContact || now,
        input.fleetIdentity ? JSON.stringify(input.fleetIdentity) : null,
        input.github?.trim() || null,
        input.email?.trim() || null,
        JSON.stringify(input.tags || []),
        JSON.stringify(input.projects || []),
        now,
        now,
        input.createdBy?.trim() || "system",
      );

    // Add initial notes if provided
    if (input.notes && input.notes.length > 0) {
      for (const note of input.notes) {
        this.addNote(id, { content: note.content, author: note.author, source: note.source });
      }
    }

    return this.get(id);
  }

  get(id: string): Person {
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as any;
    if (!row) throw new NotFoundError(`Person ${id} not found`);
    const notes = this.getNotes(id);
    return this.rowToPerson(row, notes);
  }

  list(opts?: { type?: PersonType; trustLevel?: TrustLevel; q?: string }): Person[] {
    let sql = "SELECT * FROM people";
    const params: any[] = [];
    const conditions: string[] = [];

    if (opts?.type) {
      conditions.push("type = ?");
      params.push(opts.type);
    }
    if (opts?.trustLevel) {
      conditions.push("trustLevel = ?");
      params.push(opts.trustLevel);
    }
    if (opts?.q) {
      // Simple LIKE search on name + aliases
      conditions.push("(name LIKE ? OR aliases LIKE ?)");
      const term = `%${opts.q}%`;
      params.push(term, term);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY updatedAt DESC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => {
      const notes = this.getNotes(r.id);
      return this.rowToPerson(r, notes);
    });
  }

  update(id: string, input: UpdatePersonInput): Person {
    const existing = this.get(id);
    const now = new Date().toISOString();

    const updates: Record<string, any> = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.aliases !== undefined) updates.aliases = JSON.stringify(input.aliases);
    if (input.type !== undefined) updates.type = validateType(input.type);
    if (input.relationship !== undefined) updates.relationship = input.relationship.trim();
    if (input.trustLevel !== undefined) updates.trustLevel = validateTrust(input.trustLevel);
    if (input.firstContact !== undefined) updates.firstContact = input.firstContact;
    if (input.lastContact !== undefined) updates.lastContact = input.lastContact;
    if (input.fleetIdentity !== undefined) updates.fleetIdentity = input.fleetIdentity ? JSON.stringify(input.fleetIdentity) : null;
    if (input.github !== undefined) updates.github = input.github?.trim() || null;
    if (input.email !== undefined) updates.email = input.email?.trim() || null;
    if (input.tags !== undefined) updates.tags = JSON.stringify(input.tags);
    if (input.projects !== undefined) updates.projects = JSON.stringify(input.projects);

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    updates.updatedAt = now;

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    const values = [...Object.values(updates), id];

    this.db.prepare(`UPDATE people SET ${setClauses} WHERE id = ?`).run(...values);

    return this.get(id);
  }

  delete(id: string): void {
    const result = this.db.prepare("DELETE FROM people WHERE id = ?").run(id);
    if (result.changes === 0) throw new NotFoundError(`Person ${id} not found`);
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  addNote(personId: string, input: AddNoteInput): Note {
    // Verify person exists
    const row = this.db.prepare("SELECT id FROM people WHERE id = ?").get(personId) as any;
    if (!row) throw new NotFoundError(`Person ${personId} not found`);

    if (!input.content?.trim()) {
      throw new ValidationError("content is required");
    }
    if (!input.author?.trim()) {
      throw new ValidationError("author is required");
    }

    const now = new Date().toISOString();
    const id = ulid();

    this.db
      .prepare(
        `INSERT INTO notes (id, personId, content, author, timestamp, source)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, personId, input.content.trim(), input.author.trim(), now, input.source?.trim() || "manual");

    // Update lastContact on the person
    this.db.prepare("UPDATE people SET updatedAt = ? WHERE id = ?").run(now, personId);

    return { id, content: input.content.trim(), author: input.author.trim(), timestamp: now, source: input.source?.trim() || "manual" };
  }

  getNotes(personId: string): Note[] {
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE personId = ? ORDER BY timestamp ASC")
      .all(personId) as any[];
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      author: r.author,
      timestamp: r.timestamp,
      source: r.source,
    }));
  }

  // ── Relationships (graph edges) ──────────────────────────────────────────

  addRelationship(fromId: string, toId: string, relationship: string): void {
    // Verify both exist
    this.get(fromId);
    this.get(toId);

    if (!relationship?.trim()) {
      throw new ValidationError("relationship description is required");
    }

    const id = ulid();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare("INSERT INTO relationships (id, fromId, toId, relationship, createdAt) VALUES (?, ?, ?, ?, ?)")
        .run(id, fromId, toId, relationship.trim(), now);
    } catch (err: any) {
      if (err.message?.includes("UNIQUE")) {
        // Update existing
        this.db
          .prepare("UPDATE relationships SET relationship = ?, createdAt = ? WHERE fromId = ? AND toId = ?")
          .run(relationship.trim(), now, fromId, toId);
      } else {
        throw err;
      }
    }
  }

  removeRelationship(fromId: string, toId: string): void {
    this.db.prepare("DELETE FROM relationships WHERE fromId = ? AND toId = ?").run(fromId, toId);
  }

  // ── Search (full-text) ───────────────────────────────────────────────────

  search(query: string): Person[] {
    if (!query?.trim()) return this.list();

    // Search people FTS
    const personRows = this.db
      .prepare(
        `SELECT p.* FROM people p
         JOIN people_fts fts ON p.rowid = fts.rowid
         WHERE people_fts MATCH ?
         ORDER BY rank`
      )
      .all(query.trim()) as any[];

    // Search notes FTS, get unique person IDs
    const noteRows = this.db
      .prepare(
        `SELECT DISTINCT n.personId FROM notes n
         JOIN notes_fts fts ON n.rowid = fts.rowid
         WHERE notes_fts MATCH ?`
      )
      .all(query.trim()) as any[];

    const personIds = new Set<string>();
    const results: Person[] = [];

    for (const r of personRows) {
      if (!personIds.has(r.id)) {
        personIds.add(r.id);
        const notes = this.getNotes(r.id);
        results.push(this.rowToPerson(r, notes));
      }
    }

    for (const r of noteRows) {
      if (!personIds.has(r.personId)) {
        personIds.add(r.personId);
        try {
          results.push(this.get(r.personId));
        } catch {
          // person might have been deleted
        }
      }
    }

    return results;
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  graph(): RelationshipGraph {
    const people = this.db.prepare("SELECT id, name, type, trustLevel FROM people").all() as any[];
    const rels = this.db.prepare("SELECT * FROM relationships").all() as any[];

    const nodes: GraphNode[] = people.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type as PersonType,
      trustLevel: p.trustLevel as TrustLevel,
    }));

    const edges: GraphEdge[] = rels.map((r) => ({
      from: r.fromId,
      to: r.toId,
      relationship: r.relationship,
    }));

    return { nodes, edges };
  }

  // ── Public Keys ───────────────────────────────────────────────────────────

  addPublicKey(personId: string, input: AddPublicKeyInput): PublicKey {
    const row = this.db.prepare("SELECT id FROM people WHERE id = ?").get(personId) as any;
    if (!row) throw new NotFoundError(`Person ${personId} not found`);

    if (!input.key?.trim()) {
      throw new ValidationError("key is required");
    }
    if (!input.type?.trim()) {
      throw new ValidationError("type is required");
    }

    const VALID_KEY_TYPES = new Set(["ssh-ed25519", "ssh-rsa", "age", "gpg", "other"]);
    if (!VALID_KEY_TYPES.has(input.type)) {
      throw new ValidationError(`Invalid key type. Must be one of: ${[...VALID_KEY_TYPES].join(", ")}`);
    }

    const now = new Date().toISOString();
    const id = ulid();

    try {
      this.db
        .prepare(
          `INSERT INTO public_keys (id, personId, type, key, fingerprint, label, discoveredFrom, addedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          personId,
          input.type,
          input.key.trim(),
          input.fingerprint?.trim() || null,
          input.label?.trim() || null,
          input.discoveredFrom?.trim() || null,
          now
        );
    } catch (err: any) {
      if (err.message?.includes("UNIQUE")) {
        // Key already exists for this person, return existing
        const existing = this.db
          .prepare("SELECT * FROM public_keys WHERE personId = ? AND key = ?")
          .get(personId, input.key.trim()) as any;
        if (existing) {
          return {
            id: existing.id,
            type: existing.type as PublicKeyType,
            key: existing.key,
            fingerprint: existing.fingerprint || undefined,
            label: existing.label || undefined,
            discoveredFrom: existing.discoveredFrom || undefined,
            addedAt: existing.addedAt,
          };
        }
      }
      throw err;
    }

    this.db.prepare("UPDATE people SET updatedAt = ? WHERE id = ?").run(now, personId);

    return {
      id,
      type: input.type,
      key: input.key.trim(),
      fingerprint: input.fingerprint?.trim() || undefined,
      label: input.label?.trim() || undefined,
      discoveredFrom: input.discoveredFrom?.trim() || undefined,
      addedAt: now,
    };
  }

  getPublicKeys(personId: string): PublicKey[] {
    const rows = this.db
      .prepare("SELECT * FROM public_keys WHERE personId = ? ORDER BY addedAt ASC")
      .all(personId) as any[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type as PublicKeyType,
      key: r.key,
      fingerprint: r.fingerprint || undefined,
      label: r.label || undefined,
      discoveredFrom: r.discoveredFrom || undefined,
      addedAt: r.addedAt,
    }));
  }

  removePublicKey(personId: string, keyId: string): void {
    const result = this.db.prepare("DELETE FROM public_keys WHERE id = ? AND personId = ?").run(keyId, personId);
    if (result.changes === 0) throw new NotFoundError(`Key ${keyId} not found for person ${personId}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private rowToPerson(row: any, notes: Note[]): Person {
    const publicKeys = this.getPublicKeys(row.id);
    return {
      id: row.id,
      name: row.name,
      aliases: row.aliases ? JSON.parse(row.aliases) : [],
      type: row.type as PersonType,
      relationship: row.relationship || "",
      trustLevel: row.trustLevel as TrustLevel,
      firstContact: row.firstContact,
      lastContact: row.lastContact,
      notes,
      publicKeys,
      fleetIdentity: row.fleetIdentity ? JSON.parse(row.fleetIdentity) : undefined,
      github: row.github || undefined,
      email: row.email || undefined,
      tags: row.tags ? JSON.parse(row.tags) : [],
      projects: row.projects ? JSON.parse(row.projects) : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy || "system",
    };
  }

  findByName(name: string): Person | null {
    // Exact name match or alias match
    const rows = this.db.prepare("SELECT * FROM people").all() as any[];
    for (const r of rows) {
      if (r.name.toLowerCase() === name.toLowerCase()) {
        const notes = this.getNotes(r.id);
        return this.rowToPerson(r, notes);
      }
      const aliases: string[] = r.aliases ? JSON.parse(r.aliases) : [];
      if (aliases.some((a) => a.toLowerCase() === name.toLowerCase())) {
        const notes = this.getNotes(r.id);
        return this.rowToPerson(r, notes);
      }
    }
    return null;
  }

  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM people").get() as any;
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
