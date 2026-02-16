import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync, recoverTmpFile } from "../utils/atomic-write.js";
import { NotFoundError, ValidationError } from "../errors.js";

// Re-export for convenience
export { NotFoundError, ValidationError } from "../errors.js";

export interface Persona {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  traits: string[];
  specializations: string[];
  author: string;
  version: number;
  parentPersona?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface PersonaVersion {
  version: number;
  snapshot: Persona;
  updatedAt: string;
  updatedBy?: string;
}

export interface CreatePersonaInput {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  traits?: string[];
  specializations?: string[];
  author: string;
  parentPersona?: string;
  tags?: string[];
}

export interface UpdatePersonaInput {
  displayName?: string;
  description?: string;
  systemPrompt?: string;
  traits?: string[];
  specializations?: string[];
  parentPersona?: string | null;
  tags?: string[];
  updatedBy?: string;
}

export interface PersonaFilters {
  tag?: string;
  author?: string;
  specialization?: string;
  includeDeleted?: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/;

interface StoreData {
  personas: Persona[];
  versions: Record<string, PersonaVersion[]>;
}

export class PersonaStore {
  private personas: Map<string, Persona> = new Map();
  private versions: Map<string, PersonaVersion[]> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/personas.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    recoverTmpFile(this.filePath);
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data: StoreData = JSON.parse(raw);
        if (Array.isArray(data.personas)) {
          for (const p of data.personas) {
            this.personas.set(p.name, p);
          }
        }
        if (data.versions && typeof data.versions === "object") {
          for (const [name, vers] of Object.entries(data.versions)) {
            this.versions.set(name, vers);
          }
        }
      }
    } catch {
      this.personas = new Map();
      this.versions = new Map();
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
    const data: StoreData = {
      personas: Array.from(this.personas.values()),
      versions: Object.fromEntries(this.versions.entries()),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  createPersona(input: CreatePersonaInput): Persona {
    if (!input.name || !NAME_RE.test(input.name)) {
      throw new ValidationError(
        "name must be 3-64 chars, lowercase alphanumeric with hyphens/underscores, starting with a letter"
      );
    }
    if (!input.displayName?.trim()) throw new ValidationError("displayName is required");
    if (!input.description?.trim()) throw new ValidationError("description is required");
    if (!input.systemPrompt?.trim()) throw new ValidationError("systemPrompt is required");
    if (!input.author?.trim()) throw new ValidationError("author is required");

    if (this.personas.has(input.name)) {
      const existing = this.personas.get(input.name)!;
      if (!existing.deleted) {
        throw new ValidationError(`persona '${input.name}' already exists`);
      }
      // Re-creating a deleted persona: treat as fresh creation
    }

    if (input.parentPersona) {
      const parent = this.personas.get(input.parentPersona);
      if (!parent || parent.deleted) {
        throw new ValidationError(`parent persona '${input.parentPersona}' not found`);
      }
    }

    const now = new Date().toISOString();
    const persona: Persona = {
      name: input.name,
      displayName: input.displayName.trim(),
      description: input.description.trim(),
      systemPrompt: input.systemPrompt.trim(),
      traits: input.traits || [],
      specializations: input.specializations || [],
      author: input.author.trim(),
      version: 1,
      parentPersona: input.parentPersona,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
      deleted: false,
    };

    this.personas.set(persona.name, persona);
    this.versions.set(persona.name, [
      { version: 1, snapshot: { ...persona }, updatedAt: now },
    ]);
    this.scheduleSave();
    return persona;
  }

  getPersona(name: string): Persona | undefined {
    const p = this.personas.get(name);
    if (!p || p.deleted) return undefined;
    return p;
  }

  listPersonas(filters?: PersonaFilters): Persona[] {
    let results = Array.from(this.personas.values());

    if (!filters?.includeDeleted) {
      results = results.filter((p) => !p.deleted);
    }
    if (filters?.tag) {
      results = results.filter((p) => p.tags.includes(filters.tag!));
    }
    if (filters?.author) {
      results = results.filter((p) => p.author === filters.author);
    }
    if (filters?.specialization) {
      results = results.filter((p) => p.specializations.includes(filters.specialization!));
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  updatePersona(name: string, input: UpdatePersonaInput): Persona {
    const persona = this.personas.get(name);
    if (!persona || persona.deleted) throw new NotFoundError("persona not found");

    if (input.displayName !== undefined && !input.displayName?.trim()) {
      throw new ValidationError("displayName cannot be empty");
    }
    if (input.description !== undefined && !input.description?.trim()) {
      throw new ValidationError("description cannot be empty");
    }
    if (input.systemPrompt !== undefined && !input.systemPrompt?.trim()) {
      throw new ValidationError("systemPrompt cannot be empty");
    }

    if (input.parentPersona !== undefined && input.parentPersona !== null) {
      if (input.parentPersona === name) {
        throw new ValidationError("persona cannot be its own parent");
      }
      const parent = this.personas.get(input.parentPersona);
      if (!parent || parent.deleted) {
        throw new ValidationError(`parent persona '${input.parentPersona}' not found`);
      }
    }

    if (input.displayName) persona.displayName = input.displayName.trim();
    if (input.description) persona.description = input.description.trim();
    if (input.systemPrompt) persona.systemPrompt = input.systemPrompt.trim();
    if (input.traits !== undefined) persona.traits = input.traits;
    if (input.specializations !== undefined) persona.specializations = input.specializations;
    if (input.tags !== undefined) persona.tags = input.tags;
    if (input.parentPersona !== undefined) {
      persona.parentPersona = input.parentPersona === null ? undefined : input.parentPersona;
    }

    persona.version += 1;
    persona.updatedAt = new Date().toISOString();

    this.personas.set(name, persona);

    // Store version snapshot
    const versions = this.versions.get(name) || [];
    versions.push({
      version: persona.version,
      snapshot: { ...persona },
      updatedAt: persona.updatedAt,
      updatedBy: input.updatedBy,
    });
    this.versions.set(name, versions);

    this.scheduleSave();
    return persona;
  }

  deletePersona(name: string): boolean {
    const persona = this.personas.get(name);
    if (!persona || persona.deleted) return false;

    persona.deleted = true;
    persona.updatedAt = new Date().toISOString();
    this.personas.set(name, persona);
    this.scheduleSave();
    return true;
  }

  getVersions(name: string): PersonaVersion[] {
    const persona = this.personas.get(name);
    if (!persona) throw new NotFoundError("persona not found");
    return this.versions.get(name) || [];
  }

  /**
   * Render the full system prompt with inheritance chain resolved.
   * Child prompts are appended after parent prompts.
   * Traits and specializations are merged (child overrides).
   */
  renderPrompt(name: string): { prompt: string; chain: string[]; traits: string[]; specializations: string[] } {
    const persona = this.personas.get(name);
    if (!persona || persona.deleted) throw new NotFoundError("persona not found");

    const chain: string[] = [];
    const prompts: string[] = [];
    let mergedTraits: string[] = [];
    let mergedSpecs: string[] = [];

    // Walk the inheritance chain (root first)
    let current: Persona | undefined = persona;
    const visited = new Set<string>();
    const ancestors: Persona[] = [];

    while (current) {
      if (visited.has(current.name)) break; // cycle protection
      visited.add(current.name);
      ancestors.unshift(current); // prepend so root is first
      if (current.parentPersona) {
        current = this.personas.get(current.parentPersona);
        if (current?.deleted) current = undefined;
      } else {
        current = undefined;
      }
    }

    for (const p of ancestors) {
      chain.push(p.name);
      prompts.push(p.systemPrompt);
      // Merge traits: parent first, then child adds unique ones
      for (const t of p.traits) {
        if (!mergedTraits.includes(t)) mergedTraits.push(t);
      }
      for (const s of p.specializations) {
        if (!mergedSpecs.includes(s)) mergedSpecs.push(s);
      }
    }

    return {
      prompt: prompts.join("\n\n"),
      chain,
      traits: mergedTraits,
      specializations: mergedSpecs,
    };
  }
}
