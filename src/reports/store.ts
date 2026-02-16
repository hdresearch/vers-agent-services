import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";

export interface Report {
  id: string;
  title: string;
  author: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateReportInput {
  title: string;
  author: string;
  content: string;
  tags?: string[];
}

export interface ReportFilters {
  tag?: string;
  author?: string;
}

export class ReportsStore {
  private reports: Map<string, Report> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/reports.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.reports)) {
          for (const r of data.reports) {
            this.reports.set(r.id, r);
          }
        }
      }
    } catch {
      this.reports = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const data = JSON.stringify({ reports: Array.from(this.reports.values()) }, null, 2);
    atomicWriteFileSync(this.filePath, data);
  }

  create(input: CreateReportInput): Report {
    if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    if (!input.author || typeof input.author !== "string" || !input.author.trim()) {
      throw new ValidationError("author is required");
    }
    if (!input.content || typeof input.content !== "string") {
      throw new ValidationError("content is required");
    }

    const now = new Date().toISOString();
    const report: Report = {
      id: ulid(),
      title: input.title.trim(),
      author: input.author.trim(),
      content: input.content,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    this.reports.set(report.id, report);
    this.scheduleSave();
    return report;
  }

  get(id: string): Report | undefined {
    return this.reports.get(id);
  }

  list(filters?: ReportFilters): Report[] {
    let results = Array.from(this.reports.values());

    if (filters?.author) {
      results = results.filter((r) => r.author === filters.author);
    }
    if (filters?.tag) {
      results = results.filter((r) => r.tags.includes(filters.tag!));
    }

    // Newest first
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  delete(id: string): boolean {
    const existed = this.reports.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
