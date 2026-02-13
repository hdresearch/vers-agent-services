import { ulid } from "ulid";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ─── Data Models ─────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  version: number;
  description: string;
  content: string;
  publishedBy: string;
  publishedAt: string;
  updatedAt: string;
  tags: string[];
  enabled: boolean;
}

export interface Extension {
  id: string;
  name: string;
  version: number;
  description: string;
  content: string;
  publishedBy: string;
  publishedAt: string;
  updatedAt: string;
  enabled: boolean;
}

export interface AgentManifest {
  agentId: string;
  vmId?: string;
  skills: { name: string; version: number }[];
  extensions: { name: string; version: number }[];
  lastSync: string;
}

export interface ChangeEvent {
  id: string;
  type: "skill" | "extension";
  name: string;
  version: number;
  action: "publish" | "update" | "remove" | "enable" | "disable";
  timestamp: string;
}

export interface SyncRequest {
  agentId: string;
  vmId?: string;
  skills: { name: string; version: number }[];
  extensions: { name: string; version: number }[];
}

export interface SyncUpdate {
  type: "skill" | "extension";
  name: string;
  version: number;
  action: "install" | "update" | "remove";
}

// ─── Inputs ──────────────────────────────────────────────────

export interface PublishSkillInput {
  name: string;
  description: string;
  content: string;
  publishedBy: string;
  tags?: string[];
  enabled?: boolean;
}

export interface PatchSkillInput {
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface PublishExtensionInput {
  name: string;
  description: string;
  content: string;
  publishedBy: string;
  enabled?: boolean;
}

export interface SkillFilters {
  tag?: string;
  enabled?: boolean;
}

// ─── Errors ──────────────────────────────────────────────────

export { NotFoundError, ValidationError } from "../errors.js";
import { NotFoundError, ValidationError } from "../errors.js";

// ─── Change Subscriber ──────────────────────────────────────

type ChangeSubscriber = (event: ChangeEvent) => void;

// ─── SkillStore ──────────────────────────────────────────────

export class SkillStore {
  private skills: Map<string, Skill> = new Map(); // keyed by name
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribers: Set<ChangeSubscriber> = new Set();
  private changeLog: ChangeEvent[] = [];

  constructor(filePath = "data/skills.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.skills)) {
          for (const s of data.skills) {
            this.skills.set(s.name, s);
          }
        }
        if (Array.isArray(data.changeLog)) {
          this.changeLog = data.changeLog;
        }
      }
    } catch {
      this.skills = new Map();
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
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify(
      { skills: Array.from(this.skills.values()), changeLog: this.changeLog },
      null,
      2,
    );
    writeFileSync(this.filePath, data, "utf-8");
  }

  private emitChange(
    action: ChangeEvent["action"],
    name: string,
    version: number,
  ): ChangeEvent {
    const event: ChangeEvent = {
      id: ulid(),
      type: "skill",
      name,
      version,
      action,
      timestamp: new Date().toISOString(),
    };
    this.changeLog.push(event);
    // Keep last 1000
    if (this.changeLog.length > 1000) {
      this.changeLog = this.changeLog.slice(-1000);
    }
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore
      }
    }
    return event;
  }

  subscribe(fn: ChangeSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  eventsSince(sinceId: string): ChangeEvent[] {
    return this.changeLog.filter((e) => e.id > sinceId);
  }

  get allChangeEvents(): ChangeEvent[] {
    return this.changeLog;
  }

  publish(input: PublishSkillInput): Skill {
    if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError("name is required");
    }
    if (!input.description || typeof input.description !== "string" || !input.description.trim()) {
      throw new ValidationError("description is required");
    }
    if (!input.content || typeof input.content !== "string") {
      throw new ValidationError("content is required");
    }
    if (!input.publishedBy || typeof input.publishedBy !== "string" || !input.publishedBy.trim()) {
      throw new ValidationError("publishedBy is required");
    }

    const name = input.name.trim();
    const existing = this.skills.get(name);
    const now = new Date().toISOString();

    if (existing) {
      // Update
      existing.description = input.description.trim();
      existing.content = input.content;
      existing.publishedBy = input.publishedBy.trim();
      existing.updatedAt = now;
      existing.version += 1;
      if (input.tags !== undefined) existing.tags = input.tags;
      if (input.enabled !== undefined) existing.enabled = input.enabled;
      this.skills.set(name, existing);
      this.scheduleSave();
      this.emitChange("update", name, existing.version);
      return existing;
    }

    const skill: Skill = {
      id: ulid(),
      name,
      version: 1,
      description: input.description.trim(),
      content: input.content,
      publishedBy: input.publishedBy.trim(),
      publishedAt: now,
      updatedAt: now,
      tags: input.tags || [],
      enabled: input.enabled !== undefined ? input.enabled : true,
    };

    this.skills.set(name, skill);
    this.scheduleSave();
    this.emitChange("publish", name, skill.version);
    return skill;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(filters?: SkillFilters): Skill[] {
    let results = Array.from(this.skills.values());

    if (filters?.tag) {
      results = results.filter((s) => s.tags.includes(filters.tag!));
    }
    if (filters?.enabled !== undefined) {
      results = results.filter((s) => s.enabled === filters.enabled);
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  patch(name: string, input: PatchSkillInput): Skill {
    const skill = this.skills.get(name);
    if (!skill) throw new NotFoundError("skill not found");

    let changed = false;
    if (input.description !== undefined) {
      skill.description = input.description;
      changed = true;
    }
    if (input.tags !== undefined) {
      skill.tags = input.tags;
      changed = true;
    }
    if (input.enabled !== undefined) {
      const wasEnabled = skill.enabled;
      skill.enabled = input.enabled;
      if (wasEnabled !== input.enabled) {
        this.emitChange(input.enabled ? "enable" : "disable", name, skill.version);
      }
      changed = true;
    }

    if (changed) {
      skill.updatedAt = new Date().toISOString();
      this.skills.set(name, skill);
      this.scheduleSave();
    }
    return skill;
  }

  delete(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    this.skills.delete(name);
    this.scheduleSave();
    this.emitChange("remove", name, skill.version);
    return true;
  }

  /** Returns a manifest of all enabled skills and extensions with names + versions */
  manifest(): { name: string; version: number }[] {
    return Array.from(this.skills.values())
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, version: s.version }));
  }

  clear(): void {
    this.skills.clear();
    this.changeLog = [];
    this.scheduleSave();
  }
}

// ─── ExtensionStore ──────────────────────────────────────────

export class ExtensionStore {
  private extensions: Map<string, Extension> = new Map(); // keyed by name
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribers: Set<ChangeSubscriber> = new Set();
  private changeLog: ChangeEvent[] = [];

  constructor(filePath = "data/extensions.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.extensions)) {
          for (const e of data.extensions) {
            this.extensions.set(e.name, e);
          }
        }
        if (Array.isArray(data.changeLog)) {
          this.changeLog = data.changeLog;
        }
      }
    } catch {
      this.extensions = new Map();
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
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify(
      { extensions: Array.from(this.extensions.values()), changeLog: this.changeLog },
      null,
      2,
    );
    writeFileSync(this.filePath, data, "utf-8");
  }

  private emitChange(
    action: ChangeEvent["action"],
    name: string,
    version: number,
  ): ChangeEvent {
    const event: ChangeEvent = {
      id: ulid(),
      type: "extension",
      name,
      version,
      action,
      timestamp: new Date().toISOString(),
    };
    this.changeLog.push(event);
    if (this.changeLog.length > 1000) {
      this.changeLog = this.changeLog.slice(-1000);
    }
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore
      }
    }
    return event;
  }

  subscribe(fn: ChangeSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  eventsSince(sinceId: string): ChangeEvent[] {
    return this.changeLog.filter((e) => e.id > sinceId);
  }

  get allChangeEvents(): ChangeEvent[] {
    return this.changeLog;
  }

  publish(input: PublishExtensionInput): Extension {
    if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
      throw new ValidationError("name is required");
    }
    if (!input.description || typeof input.description !== "string" || !input.description.trim()) {
      throw new ValidationError("description is required");
    }
    if (!input.content || typeof input.content !== "string") {
      throw new ValidationError("content is required");
    }
    if (!input.publishedBy || typeof input.publishedBy !== "string" || !input.publishedBy.trim()) {
      throw new ValidationError("publishedBy is required");
    }

    const name = input.name.trim();
    const existing = this.extensions.get(name);
    const now = new Date().toISOString();

    if (existing) {
      existing.description = input.description.trim();
      existing.content = input.content;
      existing.publishedBy = input.publishedBy.trim();
      existing.updatedAt = now;
      existing.version += 1;
      if (input.enabled !== undefined) existing.enabled = input.enabled;
      this.extensions.set(name, existing);
      this.scheduleSave();
      this.emitChange("update", name, existing.version);
      return existing;
    }

    const ext: Extension = {
      id: ulid(),
      name,
      version: 1,
      description: input.description.trim(),
      content: input.content,
      publishedBy: input.publishedBy.trim(),
      publishedAt: now,
      updatedAt: now,
      enabled: input.enabled !== undefined ? input.enabled : true,
    };

    this.extensions.set(name, ext);
    this.scheduleSave();
    this.emitChange("publish", name, ext.version);
    return ext;
  }

  get(name: string): Extension | undefined {
    return this.extensions.get(name);
  }

  list(): Extension[] {
    const results = Array.from(this.extensions.values());
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  delete(name: string): boolean {
    const ext = this.extensions.get(name);
    if (!ext) return false;
    this.extensions.delete(name);
    this.scheduleSave();
    this.emitChange("remove", name, ext.version);
    return true;
  }

  manifest(): { name: string; version: number }[] {
    return Array.from(this.extensions.values())
      .filter((e) => e.enabled)
      .map((e) => ({ name: e.name, version: e.version }));
  }

  clear(): void {
    this.extensions.clear();
    this.changeLog = [];
    this.scheduleSave();
  }
}

// ─── ManifestStore ───────────────────────────────────────────

export class ManifestStore {
  private manifests: Map<string, AgentManifest> = new Map(); // keyed by agentId
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/agent-manifests.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.manifests)) {
          for (const m of data.manifests) {
            this.manifests.set(m.agentId, m);
          }
        }
      }
    } catch {
      this.manifests = new Map();
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
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify(
      { manifests: Array.from(this.manifests.values()) },
      null,
      2,
    );
    writeFileSync(this.filePath, data, "utf-8");
  }

  /**
   * Sync an agent's manifest against the current skill/extension state.
   * Returns a list of updates the agent should apply.
   */
  sync(
    request: SyncRequest,
    currentSkills: { name: string; version: number }[],
    currentExtensions: { name: string; version: number }[],
  ): SyncUpdate[] {
    if (!request.agentId || typeof request.agentId !== "string" || !request.agentId.trim()) {
      throw new ValidationError("agentId is required");
    }

    const now = new Date().toISOString();
    const manifest: AgentManifest = {
      agentId: request.agentId.trim(),
      vmId: request.vmId?.trim(),
      skills: request.skills || [],
      extensions: request.extensions || [],
      lastSync: now,
    };
    this.manifests.set(manifest.agentId, manifest);
    this.scheduleSave();

    const updates: SyncUpdate[] = [];

    // Build maps of what agent has
    const agentSkills = new Map(request.skills.map((s) => [s.name, s.version]));
    const agentExtensions = new Map(request.extensions.map((e) => [e.name, e.version]));

    // Build maps of what's current
    const hubSkills = new Map(currentSkills.map((s) => [s.name, s.version]));
    const hubExtensions = new Map(currentExtensions.map((e) => [e.name, e.version]));

    // Skills: install or update
    for (const [name, version] of hubSkills) {
      const agentVersion = agentSkills.get(name);
      if (agentVersion === undefined) {
        updates.push({ type: "skill", name, version, action: "install" });
      } else if (agentVersion < version) {
        updates.push({ type: "skill", name, version, action: "update" });
      }
    }

    // Skills: remove (agent has it but hub doesn't)
    for (const [name, version] of agentSkills) {
      if (!hubSkills.has(name)) {
        updates.push({ type: "skill", name, version, action: "remove" });
      }
    }

    // Extensions: install or update
    for (const [name, version] of hubExtensions) {
      const agentVersion = agentExtensions.get(name);
      if (agentVersion === undefined) {
        updates.push({ type: "extension", name, version, action: "install" });
      } else if (agentVersion < version) {
        updates.push({ type: "extension", name, version, action: "update" });
      }
    }

    // Extensions: remove
    for (const [name, version] of agentExtensions) {
      if (!hubExtensions.has(name)) {
        updates.push({ type: "extension", name, version, action: "remove" });
      }
    }

    return updates;
  }

  get(agentId: string): AgentManifest | undefined {
    return this.manifests.get(agentId);
  }

  list(): AgentManifest[] {
    const results = Array.from(this.manifests.values());
    results.sort((a, b) => b.lastSync.localeCompare(a.lastSync));
    return results;
  }

  clear(): void {
    this.manifests.clear();
    this.scheduleSave();
  }
}
