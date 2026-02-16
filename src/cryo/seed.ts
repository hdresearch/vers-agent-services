/**
 * Seed script for the Cryochamber.
 * Run: npx tsx src/cryo/seed.ts
 */
import { CryoStore } from "./store.js";

const store = new CryoStore();

try {
  store.getAgent("puck");
  console.log("puck already exists, skipping seed");
} catch {
  const puck = store.createAgent({
    name: "puck",
    displayName: "Puck",
    persona: "orchestrator",
    status: "awake",
    tags: ["core", "orchestrator", "original"],
    trustLevel: "core",
    specializations: ["swarm-coordination", "task-delegation", "architecture"],
  });

  store.addEvent("puck", {
    event: "Named himself Puck on Valentine's Day 2026",
    metadata: { holiday: "valentine", year: 2026, selfChosen: true },
  });

  store.flush();
  console.log("Seeded agent:", puck.name);
  console.log(store.composeBriefing("puck"));
}
