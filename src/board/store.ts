import { ulid } from "ulid";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface Note {
  id: string;
  author: string;
  content: string;
  type: "finding" | "blocker" | "question" | "update";
  createdAt: string;
}

export type TaskStatus = "open" | "in_progress" | "in_review" | "blocked" | "done";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  tags: string[];
  dependencies: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: Note[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  dependencies?: string[];
  createdBy: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string | null;
  tags?: string[];
  dependencies?: string[];
}

export interface AddNoteInput {
  author: string;
  content: string;
  type: Note["type"];
}

export interface TaskFilters {
  status?: TaskStatus;
  assignee?: string;
  tag?: string;
}

const VALID_STATUSES: Set<string> = new Set(["open", "in_progress", "in_review", "blocked", "done"]);
const VALID_NOTE_TYPES: Set<string> = new Set(["finding", "blocker", "question", "update"]);

export class BoardStore {
  private tasks: Map<string, Task> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing = false;
  private pendingWrite = false;

  constructor(filePath = "data/board.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.tasks)) {
          for (const t of data.tasks) {
            this.tasks.set(t.id, t);
          }
        }
      }
    } catch {
      // Start fresh if file is corrupted
      this.tasks = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  /** Flush pending writes to disk synchronously */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify({ tasks: Array.from(this.tasks.values()) }, null, 2);
    writeFileSync(this.filePath, data, "utf-8");
  }

  createTask(input: CreateTaskInput): Task {
    if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    if (!input.createdBy || typeof input.createdBy !== "string" || !input.createdBy.trim()) {
      throw new ValidationError("createdBy is required");
    }
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: ulid(),
      title: input.title.trim(),
      description: input.description?.trim(),
      status: input.status || "open",
      assignee: input.assignee?.trim(),
      tags: input.tags || [],
      dependencies: input.dependencies || [],
      createdBy: input.createdBy.trim(),
      createdAt: now,
      updatedAt: now,
      notes: [],
    };

    this.tasks.set(task.id, task);
    this.scheduleSave();
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(filters?: TaskFilters): Task[] {
    let results = Array.from(this.tasks.values());

    if (filters?.status) {
      results = results.filter((t) => t.status === filters.status);
    }
    if (filters?.assignee) {
      results = results.filter((t) => t.assignee === filters.assignee);
    }
    if (filters?.tag) {
      results = results.filter((t) => t.tags.includes(filters.tag!));
    }

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError("task not found");

    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    if (input.title !== undefined) {
      if (typeof input.title !== "string" || !input.title.trim()) {
        throw new ValidationError("title cannot be empty");
      }
      task.title = input.title.trim();
    }
    if (input.description !== undefined) task.description = input.description?.trim();
    if (input.status !== undefined) task.status = input.status;
    if (input.assignee !== undefined) task.assignee = input.assignee === null ? undefined : input.assignee?.trim();
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.dependencies !== undefined) task.dependencies = input.dependencies;

    task.updatedAt = new Date().toISOString();
    this.tasks.set(id, task);
    this.scheduleSave();
    return task;
  }

  deleteTask(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  addNote(taskId: string, input: AddNoteInput): Note {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFoundError("task not found");

    if (!input.author?.trim()) throw new ValidationError("author is required");
    if (!input.content?.trim()) throw new ValidationError("content is required");
    if (!VALID_NOTE_TYPES.has(input.type)) throw new ValidationError(`invalid note type: ${input.type}`);

    const note: Note = {
      id: ulid(),
      author: input.author.trim(),
      content: input.content.trim(),
      type: input.type,
      createdAt: new Date().toISOString(),
    };

    task.notes.push(note);
    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    this.scheduleSave();
    return note;
  }

  getNotes(taskId: string): Note[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFoundError("task not found");
    return task.notes;
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
