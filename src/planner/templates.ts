/**
 * Sprint templates — pre-configured sprint shapes that bias task selection
 * and persona assignment toward a particular goal.
 */

export interface SprintTemplate {
  name: string;
  description: string;
  /** Tags to prioritize when selecting tasks */
  preferTags: string[];
  /** Tags to deprioritize / exclude */
  avoidTags: string[];
  /** Suggested persona distribution (persona name -> max count) */
  personas: Record<string, number>;
  /** Effort bias: prefer smaller or larger tasks? */
  effortBias: "small" | "balanced" | "large";
  /** Extra instructions appended to LLM prompt */
  guidance: string;
}

export const TEMPLATES: Record<string, SprintTemplate> = {
  "bug-bash": {
    name: "Bug Bash",
    description: "Focus on fixing known bugs and resolving blockers",
    preferTags: ["bug", "fix", "broken", "regression", "P0", "critical", "blocked"],
    avoidTags: ["feature", "content", "blog", "docs"],
    personas: {
      "debugger": 4,
      "infra": 2,
      "architect": 1,
    },
    effortBias: "small",
    guidance: "Prioritize blocked tasks first. Prefer tasks that unblock other tasks. Group related bugs together for the same agent.",
  },

  "feature-sprint": {
    name: "Feature Sprint",
    description: "Ship new features and capabilities",
    preferTags: ["feature", "enhancement", "new", "build", "ship"],
    avoidTags: ["cleanup", "refactor", "debt"],
    personas: {
      "builder": 4,
      "architect": 2,
      "reviewer": 1,
    },
    effortBias: "balanced",
    guidance: "Group related features. Ensure dependencies are ordered correctly. Include a reviewer agent for QA.",
  },

  "content-wave": {
    name: "Content Wave",
    description: "Produce documentation, blog posts, and external-facing content",
    preferTags: ["content", "blog", "docs", "readme", "writing", "demo", "external"],
    avoidTags: ["infra", "devops", "internal"],
    personas: {
      "writer": 4,
      "editor": 2,
      "designer": 1,
    },
    effortBias: "balanced",
    guidance: "Prioritize external-facing content. Group by audience. Ensure consistent voice.",
  },

  "infra-hardening": {
    name: "Infra Hardening",
    description: "Improve reliability, monitoring, and infrastructure",
    preferTags: ["infra", "devops", "monitoring", "reliability", "security", "deploy", "ops"],
    avoidTags: ["feature", "content", "blog"],
    personas: {
      "infra": 3,
      "architect": 2,
      "sre": 2,
    },
    effortBias: "balanced",
    guidance: "Prioritize reliability and security. Snapshot before any destructive changes. Sequential execution for infra tasks.",
  },

  "cleanup-wave": {
    name: "Cleanup Wave",
    description: "Pay down tech debt, refactor, close stale tasks",
    preferTags: ["cleanup", "refactor", "debt", "stale", "chore", "deprecate"],
    avoidTags: ["feature", "urgent"],
    personas: {
      "janitor": 4,
      "architect": 2,
    },
    effortBias: "small",
    guidance: "Close stale tasks aggressively. Prefer tasks that simplify the codebase. Bundle small related cleanups for one agent.",
  },
};

export function getTemplate(name: string): SprintTemplate | undefined {
  return TEMPLATES[name];
}

export function listTemplates(): { name: string; description: string }[] {
  return Object.values(TEMPLATES).map((t) => ({
    name: t.name,
    description: t.description,
  }));
}
