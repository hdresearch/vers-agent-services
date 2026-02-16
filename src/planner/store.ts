import Database from "better-sqlite3";
import { ulid } from "ulid";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// --- Types ---

export interface SprintTask {
  taskId: string;
  title: string;
  persona: string;
  priority: number;       // 0 = highest
  effort: string;
  estimatedTokens: number;
  reason: string;
  dependencies: string[];
  parallel: boolean;      // can run in parallel with others in same group
}

export interface SprintGroup {
  persona: string;
  tasks: SprintTask[];
  totalTokens: number;
}

export interface SprintPlan {
  id: string;
  intent: string;
  budget: number;
  constraints: string[];
  template?: string;
  groups: SprintGroup[];
  totalTasks: number;
  totalTokens: number;
  reasoning: string;
  createdAt: string;
}

export interface CreateSprintInput {
  intent: string;
  budget: number;
  constraints?: string[];
  template?: string;
  groups: SprintGroup[];
  totalTasks: number;
  totalTokens: number;
  reasoning: string;
}

// --- Store ---

export class PlannerStore {
  private db: Database.Database;

  constructor(dbPath = "data/planner.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sprints (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL,
        budget INTEGER NOT NULL,
        constraints TEXT NOT NULL DEFAULT '[]',
        template TEXT,
        groups TEXT NOT NULL DEFAULT '[]',
        total_tasks INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )
    `);
  }

  saveSprint(input: CreateSprintInput): SprintPlan {
    const id = ulid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO sprints (id, intent, budget, constraints, template, groups, total_tasks, total_tokens, reasoning, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.intent,
      input.budget,
      JSON.stringify(input.constraints || []),
      input.template || null,
      JSON.stringify(input.groups),
      input.totalTasks,
      input.totalTokens,
      input.reasoning,
      now,
    );

    return {
      id,
      intent: input.intent,
      budget: input.budget,
      constraints: input.constraints || [],
      template: input.template,
      groups: input.groups,
      totalTasks: input.totalTasks,
      totalTokens: input.totalTokens,
      reasoning: input.reasoning,
      createdAt: now,
    };
  }

  getSprint(id: string): SprintPlan | undefined {
    const row = this.db.prepare("SELECT * FROM sprints WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return this.rowToPlan(row);
  }

  listSprints(limit = 20): SprintPlan[] {
    const rows = this.db.prepare("SELECT * FROM sprints ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.map((r) => this.rowToPlan(r));
  }

  private rowToPlan(row: any): SprintPlan {
    return {
      id: row.id,
      intent: row.intent,
      budget: row.budget,
      constraints: JSON.parse(row.constraints),
      template: row.template || undefined,
      groups: JSON.parse(row.groups),
      totalTasks: row.total_tasks,
      totalTokens: row.total_tokens,
      reasoning: row.reasoning,
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
