import { describe, it, expect } from "vitest";
import { getTemplate, listTemplates, TEMPLATES } from "../templates.js";

describe("templates", () => {
  it("lists all templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBe(5);
    const names = templates.map((t) => t.name);
    expect(names).toContain("Bug Bash");
    expect(names).toContain("Feature Sprint");
    expect(names).toContain("Content Wave");
    expect(names).toContain("Infra Hardening");
    expect(names).toContain("Cleanup Wave");
  });

  it("gets a template by key", () => {
    const t = getTemplate("bug-bash");
    expect(t).toBeDefined();
    expect(t!.name).toBe("Bug Bash");
    expect(t!.preferTags).toContain("bug");
    expect(t!.effortBias).toBe("small");
  });

  it("returns undefined for unknown template", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });

  it("all templates have required fields", () => {
    for (const [key, t] of Object.entries(TEMPLATES)) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(Array.isArray(t.preferTags)).toBe(true);
      expect(Array.isArray(t.avoidTags)).toBe(true);
      expect(typeof t.personas).toBe("object");
      expect(["small", "balanced", "large"]).toContain(t.effortBias);
      expect(t.guidance).toBeTruthy();
    }
  });
});
