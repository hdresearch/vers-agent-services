/**
 * Seed the Knowledge Base with entries extracted from fleet operations.
 * Run: bun run src/kb/seed.ts
 *
 * Uses the KB API to create entries, so the server must be running.
 * Or import the store directly for offline seeding.
 */

import { KBStore, type CreateEntryInput } from "./store.js";

const seeds: CreateEntryInput[] = [
  // === WARNINGS ===
  {
    type: "warning",
    content: "agent-services is a systemd unit — use `systemctl restart agent-services`, never pkill/nohup. Killing the process without systemctl causes zombie states.",
    source: "infra-deploy skill, multiple incidents",
    tags: ["deploy", "infra", "systemd"],
    confidence: 9,
  },
  {
    type: "warning",
    content: "vers_swarm_spawn needs literal API key string, not env var reference. Passing $VERS_API_KEY as a string doesn't expand — pass the actual key value.",
    source: "3 separate incidents during swarm operations",
    tags: ["swarm", "spawn", "api-key"],
    confidence: 9,
  },
  {
    type: "warning",
    content: "SkillHub sync skips 16/24 skills due to git checkout shadowing — local .pi/agent/skills dir can shadow SkillHub skills. Must publish to BOTH SkillHub AND local.",
    source: "P0 board task, skillhub audit",
    tags: ["skillhub", "skills", "sync"],
    confidence: 8,
  },
  {
    type: "warning",
    content: "Caddy reverse proxy on infra VM expects agent-services on port 3000. If the port changes or service crashes, Caddy returns 502. Check `systemctl status agent-services` first.",
    source: "infra architecture",
    tags: ["infra", "caddy", "proxy"],
    confidence: 7,
  },
  {
    type: "warning",
    content: "VM memory is limited (~483MB). npm install frequently OOM-kills. Use bun install instead — it's the project's package manager (bun.lock exists).",
    source: "multiple build failures",
    tags: ["build", "memory", "bun"],
    confidence: 8,
  },
  {
    type: "warning",
    content: "Never deploy without reading the deploy skill first. Pre-deploy snapshot is mandatory — it's the only rollback path.",
    source: "deploy skill, operational policy",
    tags: ["deploy", "snapshot", "rollback"],
    confidence: 9,
  },

  // === CONVENTIONS ===
  {
    type: "convention",
    content: "Always snapshot infra VM before deploying any code changes. Use vers commit before vers destroy. No snapshot = no rollback.",
    source: "deploy skill, commit-discipline skill",
    tags: ["deploy", "snapshot", "infra"],
    confidence: 9,
  },
  {
    type: "convention",
    content: "Publish skills to SkillHub AND local filesystem, not just local. Local-only skills get lost on VM recreation.",
    source: "skillhub audit findings",
    tags: ["skills", "skillhub", "publish"],
    confidence: 8,
  },
  {
    type: "convention",
    content: "Chain follow-up actions when agents complete tasks — don't wait for human intervention. If a build succeeds, auto-deploy. If tests pass, auto-merge.",
    source: "fleet operations review",
    tags: ["automation", "fleet", "workflow"],
    confidence: 7,
  },
  {
    type: "convention",
    content: "All new services follow the pattern: src/<name>/store.ts (data layer + persistence), src/<name>/routes.ts (Hono routes), mounted in server.ts with bearerAuth.",
    source: "codebase architecture",
    tags: ["architecture", "code", "patterns"],
    confidence: 9,
  },
  {
    type: "convention",
    content: "Use atomicWriteFileSync for all JSON persistence. Write to .tmp then rename — prevents data corruption on crash.",
    source: "utils/atomic-write.ts",
    tags: ["persistence", "data", "patterns"],
    confidence: 8,
  },
  {
    type: "convention",
    content: "Git branches use prefixes: feat/ for features, fix/ for bugfixes. Push to Gitea remote at b6f1cc18 VM.",
    source: "git workflow",
    tags: ["git", "workflow", "branches"],
    confidence: 7,
  },

  // === LESSONS ===
  {
    type: "lesson",
    content: "Built But Not Running pattern — fleet builds infrastructure (VMs, services, configs) then doesn't turn it on. Always verify services are actually running after deploy, not just built.",
    source: "fleet operations retrospective",
    tags: ["fleet", "deploy", "verification"],
    confidence: 8,
  },
  {
    type: "lesson",
    content: "Agent sessions are ephemeral — all state must be persisted to disk or external services. In-memory state is lost on restart. Use the board, feed, and log for coordination.",
    source: "session recovery patterns",
    tags: ["sessions", "persistence", "coordination"],
    confidence: 8,
  },
  {
    type: "lesson",
    content: "Preview deploys (clone infra VM, deploy branch on clone) are the safest way to review changes. Production stays untouched. Share the preview URL for review.",
    source: "preview-deploy skill",
    tags: ["deploy", "preview", "review"],
    confidence: 7,
  },
  {
    type: "lesson",
    content: "Token/cost tracking matters — fleet can burn through API credits fast when spawning multiple agents. Monitor usage and set budgets.",
    source: "usage tracking implementation",
    tags: ["cost", "tokens", "monitoring"],
    confidence: 7,
  },

  // === CONTEXT ===
  {
    type: "context",
    content: "Noah's current focus: seed spec RFC (public by end of next week), fleet-to-fleet testing, and making the agent services dashboard production-ready.",
    source: "user direction, Feb 2026",
    tags: ["focus", "priorities", "noah"],
    confidence: 8,
    decayDays: 14,
  },
  {
    type: "context",
    content: "Trust level: high autonomy. Noah prefers agents that take action and report results, not agents that ask permission for every step. Ship first, discuss later.",
    source: "user preferences",
    tags: ["trust", "autonomy", "noah"],
    confidence: 9,
    decayDays: 30,
  },
  {
    type: "context",
    content: "Communication style: concise, technical, no fluff. Show what was done and what's next. Use the work log and board for async updates.",
    source: "user preferences",
    tags: ["communication", "style", "noah"],
    confidence: 9,
    decayDays: 30,
  },

  // === FACTS ===
  {
    type: "fact",
    content: "Infra VM ID: e0e2bf05-93fd-4a30-b4c6-4476b45beb16. Runs agent-services (port 3000), Caddy (HTTPS), Gitea (port 3001).",
    source: "infrastructure registry",
    tags: ["infra", "vm", "infrastructure"],
    confidence: 10,
  },
  {
    type: "fact",
    content: "Gitea VM ID: b6f1cc18-713a-4e3f-bb8d-a0064646f963. Hosts git repos at port 3000. Auth: admin:4848Z0TrWwRyzI1quIxhlyHw.",
    source: "infrastructure registry",
    tags: ["gitea", "git", "infrastructure"],
    confidence: 10,
  },
  {
    type: "fact",
    content: "Bearer auth token for agent-services API: fa2490f6cd1fa376b58bcb36ac66b2a0ec51b621cdb4e0e83c9a2c58342a082f",
    source: "auth configuration",
    tags: ["auth", "api", "token"],
    confidence: 10,
  },
];

export function seedKB(store: KBStore): { created: number; entries: string[] } {
  const entries: string[] = [];
  for (const seed of seeds) {
    const entry = store.createEntry(seed);
    entries.push(`[${entry.type}] ${entry.content.slice(0, 80)}...`);
  }
  store.flush();
  return { created: entries.length, entries };
}

// CLI mode
if (import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, "") || "")) {
  const store = new KBStore();
  const result = seedKB(store);
  console.log(`✅ Seeded ${result.created} KB entries`);
  for (const e of result.entries) {
    console.log(`  ${e}`);
  }
}
