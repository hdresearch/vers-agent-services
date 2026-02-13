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

export type ArtifactType = "branch" | "report" | "deploy" | "diff" | "file" | "url";

export interface Artifact {
  type: ArtifactType;
  url: string;
  label: string;
  addedAt: string;
  addedBy?: string;
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
  artifacts: Artifact[];
  score: number;
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

export interface AddArtifactInput {
  type: ArtifactType;
  url: string;
  label: string;
  addedBy?: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  assignee?: string;
  tag?: string;
}

const VALID_STATUSES: Set<string> = new Set(["open", "in_progress", "in_review", "blocked", "done"]);
const VALID_NOTE_TYPES: Set<string> = new Set(["finding", "blocker", "question", "update"]);
const VALID_ARTIFACT_TYPES: Set<string> = new Set(["branch", "report", "deploy", "diff", "file", "url"]);

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
            // Backward compat: old tasks may not have artifacts
            if (!t.artifacts) t.artifacts = [];
            // Backward compat: default score to 0 for older tasks
            if (t.score === undefined) t.score = 0;
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
      artifacts: [],
      score: 0,
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

  bumpTask(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError("task not found");

    task.score = (task.score || 0) + 1;
    task.updatedAt = new Date().toISOString();
    this.tasks.set(id, task);
    this.scheduleSave();
    return task;
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

  addArtifacts(taskId: string, artifacts: AddArtifactInput[]): Artifact[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new NotFoundError("task not found");

    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      throw new ValidationError("artifacts array is required and must not be empty");
    }

    const now = new Date().toISOString();
    const added: Artifact[] = [];

    for (const a of artifacts) {
      if (!a.type || !VALID_ARTIFACT_TYPES.has(a.type)) {
        throw new ValidationError(`invalid artifact type: ${a.type}`);
      }
      if (!a.url?.trim()) throw new ValidationError("artifact url is required");
      if (!a.label?.trim()) throw new ValidationError("artifact label is required");

      const artifact: Artifact = {
        type: a.type,
        url: a.url.trim(),
        label: a.label.trim(),
        addedAt: now,
        addedBy: a.addedBy?.trim(),
      };
      task.artifacts.push(artifact);
      added.push(artifact);
    }

    task.updatedAt = now;
    this.tasks.set(taskId, task);
    this.scheduleSave();
    return added;
  }
}

export { NotFoundError, ValidationError } from "../errors.js";
import { NotFoundError, ValidationError } from "../errors.js";
