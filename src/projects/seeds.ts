/**
 * Pre-seed projects — the projects the fleet is already tracking.
 * Run once at startup if the projects table is empty.
 */

import type { CreateProjectInput } from "./store.js";

export const SEED_PROJECTS: CreateProjectInput[] = [
  {
    name: "oil-camp",
    displayName: "Oil Camp",
    description:
      "Rust-native fleet orchestration engine. Multi-phase build by Rustacean agents. " +
      "Persistent VM management, task distribution, health monitoring.",
    status: "active",
    tags: ["oil-camp", "oil", "rustacean", "rust"],
    matchers: {
      boardTags: ["oil-camp", "oil", "rustacean"],
      boardTitlePatterns: ["oil.?camp", "rustacean"],
      reportTags: ["oil-camp", "oil", "rustacean"],
      reportAuthors: ["rustacean", "rustacean-r4", "rustacean-r5"],
      feedPatterns: ["oil camp", "rustacean"],
      logPatterns: ["oil-camp", "rustacean"],
      gitBranches: ["oil-camp", "feat/oil"],
      agents: ["rustacean"],
      repos: ["hdresearch/oil-camp"],
    },
  },
  {
    name: "fleet-seeds",
    displayName: "Fleet Seeds",
    description:
      "Seed specification system — composable fleet capability packages. " +
      "How fleets share and adopt patterns, tools, and services.",
    status: "active",
    tags: ["seed", "seeds", "fleet-seeds", "spec"],
    matchers: {
      boardTags: ["seed", "seeds", "fleet-seeds"],
      boardTitlePatterns: ["seed", "fleet.?seed"],
      reportTags: ["seed", "seeds", "fleet-seeds"],
      reportAuthors: [],
      feedPatterns: ["seed", "fleet-seeds"],
      logPatterns: ["seed", "fleet-seeds"],
      gitBranches: ["feat/seeds", "seed"],
      agents: [],
      repos: ["hdresearch/fleet-seeds", "admin/seed-spec"],
    },
  },
  {
    name: "thorium-bridge",
    displayName: "Thorium Bridge",
    description:
      "ACCP (Autonomous Claude-to-Claude Protocol) — inter-fleet communication. " +
      "Named agents: Marlowe (investigator), Virgil (guide), Calliope (narrator).",
    status: "active",
    tags: ["thorium", "accp", "bridge", "inter-fleet"],
    matchers: {
      boardTags: ["thorium", "accp", "bridge"],
      boardTitlePatterns: ["thorium", "accp", "bridge"],
      reportTags: ["thorium", "accp"],
      reportAuthors: ["marlowe", "virgil", "calliope"],
      feedPatterns: ["thorium", "accp", "bridge"],
      logPatterns: ["thorium", "accp"],
      gitBranches: ["thorium", "feat/accp"],
      agents: ["marlowe", "virgil", "calliope"],
      repos: [],
    },
  },
  {
    name: "autonomous-loop",
    displayName: "Autonomous Loop",
    description:
      "Self-directed fleet operation — daemon mode, autonomous task planning, " +
      "aegis safety guard. The fleet runs itself.",
    status: "active",
    tags: ["autonomy", "aegis", "daemon", "loop", "planner"],
    matchers: {
      boardTags: ["autonomy", "aegis", "daemon", "loop"],
      boardTitlePatterns: ["autonom", "daemon", "aegis", "loop"],
      reportTags: ["autonomy", "aegis", "daemon"],
      reportAuthors: ["aegis", "euclid"],
      feedPatterns: ["autonomy", "daemon", "aegis", "loop"],
      logPatterns: ["daemon", "aegis", "autonomy"],
      gitBranches: ["feat/daemon", "feat/aegis", "feat/autonomy"],
      agents: ["aegis", "euclid"],
      repos: [],
    },
  },
  {
    name: "fleet-chat",
    displayName: "Fleet Chat / Inter-fleet",
    description:
      "Cross-fleet communication, contacts directory, fleet discovery. " +
      "Hermes (messenger), Irulan (diplomat). Joseph contact integration.",
    status: "active",
    tags: ["fleet-chat", "contacts", "joseph", "inter-fleet", "hermes"],
    matchers: {
      boardTags: ["fleet-chat", "contacts", "joseph", "hermes"],
      boardTitlePatterns: ["fleet.?chat", "contact", "inter.?fleet"],
      reportTags: ["fleet-chat", "contacts"],
      reportAuthors: ["hermes", "irulan"],
      feedPatterns: ["fleet-chat", "contacts", "hermes", "irulan"],
      logPatterns: ["fleet-chat", "contacts"],
      gitBranches: ["feat/fleet-chat", "feat/contacts"],
      agents: ["hermes", "irulan"],
      repos: [],
    },
  },
];
