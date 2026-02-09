#!/usr/bin/env node
/**
 * Seed the SkillHub with existing skills from disk.
 * Run after the server is started.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TOKEN = process.env.TOKEN || readFileSync("/root/workspace/vers-agent-services/.auth-token", "utf-8").trim();

const skillFiles = [
  "skills/board/SKILL.md",
  "skills/feed/SKILL.md",
  "skills/registry/SKILL.md",
];

async function publishSkill(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const dir = dirname(filePath);
  const name = basename(dir);

  // Extract description from first non-heading paragraph
  const lines = content.split("\n");
  let description = "";
  let pastHeading = false;
  for (const line of lines) {
    if (line.startsWith("# ")) {
      pastHeading = true;
      continue;
    }
    if (pastHeading && line.trim()) {
      description = line.trim();
      break;
    }
  }

  const body = {
    name,
    description: description || `${name} skill`,
    content,
    publishedBy: "seed-script",
    tags: ["core"],
  };

  const res = await fetch(`${BASE_URL}/skills/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(`${res.status === 201 ? "✓" : "✗"} ${name} v${data.version || "?"} — ${description.slice(0, 60)}`);
}

console.log("Seeding SkillHub...\n");
for (const file of skillFiles) {
  await publishSkill(file);
}
console.log("\nDone. Fetching manifest...");

const manifestRes = await fetch(`${BASE_URL}/skills/manifest`, {
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});
const manifest = await manifestRes.json();
console.log(JSON.stringify(manifest, null, 2));
