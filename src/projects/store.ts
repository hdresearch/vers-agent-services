import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface ProjectMatchers {
  boardTags: string[];
  boardTitlePatterns: string[];
  reportTags: string[];
  reportAuthors: string[];
  feedPatterns: string[];
  logPatterns: string[];
  gitBranches: string[];
  agents: string[];
  repos: string[];
}

export type ProjectStatus = "active" | "paused" | "complete" | "abandoned";

export const VALID_STATUSES: Set<string> = new Set([
  "active",
  "paused",
  "complete",
  "abandoned",
]);

export interface Project {
  id: string;
  name: string;
  displayName: string;
  description: string;
  status: ProjectStatus;
  tags: string[];
  matchers: ProjectMatchers;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  displayName: string;
  description?: string;
  status?: ProjectStatus;
  tags?: string[];
  matchers?: Partial<ProjectMatchers>;
}

export interface UpdateProjectInput {
  name?: string;
  displayName?: string;
  description?: string;
  status?: ProjectStatus;
  tags?: string[];
  matchers?: Partial<ProjectMatchers>;
}

export interface ProjectFilters {
  status?: ProjectStatus;
  tag?: string;
}

// ── Validation helpers ─────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function defaultMatchers(): ProjectMatchers {
  return {
    boardTags: [],
    boardTitlePatterns: [],
    reportTags: [],
    reportAuthors: [],
    feedPatterns: [],
    logPatterns: [],
    gitBranches: [],
    agents: [],
    repos: [],
  };
}

// ── Store ──────────────────────────────────────────────────────────────

export class ProjectStore {
  private db: Database.Database;

  constructor(dbPath = "data/projects.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        displayName TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active',
        tags        TEXT NOT NULL DEFAULT '[]',
        matchers    TEXT NOT NULL DEFAULT '{}',
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    `);
  }

  private rowToProject(row: any): Project {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      status: row.status as ProjectStatus,
      tags: JSON.parse(row.tags),
      matchers: { ...defaultMatchers(), ...JSON.parse(row.matchers) },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  create(input: CreateProjectInput): Project {
    if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError("name is required");
    }
    if (
      !input.displayName ||
      typeof input.displayName !== "string" ||
      !input.displayName.trim()
    ) {
      throw new ValidationError("displayName is required");
    }
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(
        `Invalid status "${input.status}". Valid: ${[...VALID_STATUSES].join(", ")}`,
      );
    }

    // Check uniqueness
    const existing = this.db
      .prepare("SELECT id FROM projects WHERE name = ?")
      .get(input.name);
    if (existing) {
      throw new ValidationError(`Project with name "${input.name}" already exists`);
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: ulid(),
      name: input.name.trim(),
      displayName: input.displayName.trim(),
      description: input.description?.trim() || "",
      status: input.status || "active",
      tags: input.tags || [],
      matchers: { ...defaultMatchers(), ...(input.matchers || {}) },
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, name, displayName, description, status, tags, matchers, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.displayName,
        project.description,
        project.status,
        JSON.stringify(project.tags),
        JSON.stringify(project.matchers),
        project.createdAt,
        project.updatedAt,
      );

    return project;
  }

  get(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? this.rowToProject(row) : null;
  }

  getByName(name: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name);
    return row ? this.rowToProject(row) : null;
  }

  list(filters?: ProjectFilters): Project[] {
    let sql = "SELECT * FROM projects";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.tag) {
      // JSON array contains — SQLite JSON1 extension
      conditions.push("json_each.value = ?");
      sql = `SELECT projects.* FROM projects, json_each(projects.tags)`;
      params.push(filters.tag);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY createdAt DESC";

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r: any) => this.rowToProject(r));
  }

  update(id: string, input: UpdateProjectInput): Project | null {
    const existing = this.get(id);
    if (!existing) return null;

    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(
        `Invalid status "${input.status}". Valid: ${[...VALID_STATUSES].join(", ")}`,
      );
    }

    if (input.name && input.name !== existing.name) {
      const dupe = this.db
        .prepare("SELECT id FROM projects WHERE name = ? AND id != ?")
        .get(input.name, id);
      if (dupe) {
        throw new ValidationError(
          `Project with name "${input.name}" already exists`,
        );
      }
    }

    const now = new Date().toISOString();
    const updated: Project = {
      ...existing,
      name: input.name?.trim() || existing.name,
      displayName: input.displayName?.trim() || existing.displayName,
      description:
        input.description !== undefined
          ? input.description.trim()
          : existing.description,
      status: input.status || existing.status,
      tags: input.tags || existing.tags,
      matchers: input.matchers
        ? { ...existing.matchers, ...input.matchers }
        : existing.matchers,
      updatedAt: now,
    };

    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, displayName = ?, description = ?, status = ?,
             tags = ?, matchers = ?, updatedAt = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.displayName,
        updated.description,
        updated.status,
        JSON.stringify(updated.tags),
        JSON.stringify(updated.matchers),
        updated.updatedAt,
        id,
      );

    return updated;
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM projects WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
