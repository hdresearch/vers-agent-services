import { Hono } from "hono";
import { PlannerStore } from "./store.js";
import { analyzeBoard, summarizeAnalysis } from "./analyzer.js";
import { getTemplate, listTemplates, TEMPLATES } from "./templates.js";
import { boardStore } from "../board/shared-store.js";
import { emit } from "../events/emit.js";
import { createDeepLinkedNotification } from "../notifications/deeplink.js";
import type { Task } from "../board/store.js";
import type { SprintGroup, SprintTask } from "./store.js";
import type { SprintTemplate } from "./templates.js";

export const plannerStore = new PlannerStore();
export const plannerRoutes = new Hono();

// --- Helpers: gather context from sibling services ---

const INFRA_URL = process.env.VERS_INFRA_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.VERS_AUTH_TOKEN || "";

async function fetchJSON(path: string): Promise<any> {
  try {
    const res = await fetch(`${INFRA_URL}${path}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function getRecentFeed(limit = 30): Promise<string> {
  const data = await fetchJSON(`/feed/events?limit=${limit}`);
  if (!data?.events) return "No recent feed events.";
  return data.events
    .slice(0, limit)
    .map((e: any) => `[${e.type}] ${e.agent}: ${e.summary}`)
    .join("\n");
}

async function getKBBriefing(): Promise<string> {
  const data = await fetchJSON("/kb/briefing");
  if (!data?.briefing) return "No KB briefing available.";
  return typeof data.briefing === "string"
    ? data.briefing
    : JSON.stringify(data.briefing).slice(0, 2000);
}

async function getPersonas(): Promise<string[]> {
  const data = await fetchJSON("/personas");
  if (!data?.personas) return [];
  return data.personas.map((p: any) => p.name);
}

// --- LLM call via local router ---

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `${INFRA_URL}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-id": "sprint-planner",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM router returned ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || "";
}

// --- Token estimation ---

const TOKEN_ESTIMATES: Record<string, number> = {
  trivial: 5_000,
  small: 20_000,
  medium: 60_000,
  large: 150_000,
};

function estimateTokens(effort: string): number {
  return TOKEN_ESTIMATES[effort] || TOKEN_ESTIMATES.medium;
}

// --- Build LLM prompt ---

function buildSystemPrompt(): string {
  return `You are a sprint planner for an AI agent fleet. You take a board of tasks, the user's intent for the week, and constraints, and produce a sprint plan.

Your output MUST be valid JSON matching this schema:
{
  "groups": [
    {
      "persona": "builder",
      "tasks": [
        {
          "taskId": "01ABC...",
          "title": "Task title",
          "persona": "builder",
          "priority": 0,
          "effort": "small",
          "estimatedTokens": 20000,
          "reason": "Why this task fits the sprint intent",
          "dependencies": [],
          "parallel": true
        }
      ],
      "totalTokens": 20000
    }
  ],
  "reasoning": "2-3 sentence explanation of why this plan matches the intent"
}

Rules:
- Only include tasks from the provided board (use exact taskId)
- Respect the budget (max number of agents to dispatch)
- Respect all constraints
- Group tasks by persona — each group is dispatched to one agent
- Order tasks within a group by priority (0 = do first)
- Set parallel=true if the task has no dependencies within the sprint
- estimatedTokens based on effort: trivial=5K, small=20K, medium=60K, large=150K
- Output ONLY the JSON, no markdown fences, no explanation outside the JSON`;
}

function buildUserPrompt(
  intent: string,
  budget: number,
  constraints: string[],
  analysis: string,
  openTasks: Task[],
  feedContext: string,
  kbContext: string,
  template?: SprintTemplate,
): string {
  const taskList = openTasks
    .slice(0, 100) // cap for context window
    .map((t) => {
      const deps = t.dependencies.length > 0 ? ` deps=[${t.dependencies.join(",")}]` : "";
      const tags = t.tags.length > 0 ? ` tags=[${t.tags.join(",")}]` : "";
      return `- ${t.id}: "${t.title}" effort=${t.effort || "unset"} score=${t.score}${deps}${tags}`;
    })
    .join("\n");

  let prompt = `## Sprint Intent
${intent}

## Budget
${budget} agents max

## Constraints
${constraints.length > 0 ? constraints.map((c) => `- ${c}`).join("\n") : "None"}

## Board Analysis
${analysis}

## Open Tasks
${taskList}

## Recent Activity
${feedContext}

## Knowledge Base Lessons
${kbContext}`;

  if (template) {
    prompt += `\n\n## Template: ${template.name}
${template.description}
Prefer tags: ${template.preferTags.join(", ")}
Avoid tags: ${template.avoidTags.join(", ")}
Suggested personas: ${Object.entries(template.personas).map(([k, v]) => `${k}(${v})`).join(", ")}
Effort bias: ${template.effortBias}
Guidance: ${template.guidance}`;
  }

  return prompt;
}

// --- Routes ---

/**
 * POST /planner/sprint — Generate a sprint plan
 */
plannerRoutes.post("/sprint", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { intent, budget, constraints = [], template: templateName } = body;

  if (!intent || typeof intent !== "string") {
    return c.json({ error: "intent is required (string)" }, 400);
  }
  if (!budget || typeof budget !== "number" || budget < 1 || budget > 50) {
    return c.json({ error: "budget is required (number 1-50)" }, 400);
  }

  // Get template if specified
  const template = templateName ? getTemplate(templateName) : undefined;
  if (templateName && !template) {
    return c.json({ error: `Unknown template: ${templateName}. Available: ${Object.keys(TEMPLATES).join(", ")}` }, 400);
  }

  // Gather context in parallel
  const allTasks = boardStore.listTasks();
  const openTasks = allTasks.filter((t) => t.status === "open" || t.status === "blocked");

  const [feedContext, kbContext] = await Promise.all([
    getRecentFeed(),
    getKBBriefing(),
  ]);

  // Analyze board
  const analysis = analyzeBoard(allTasks);
  const analysisSummary = summarizeAnalysis(analysis);

  // Call LLM
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(
    intent, budget, constraints, analysisSummary,
    openTasks, feedContext, kbContext, template,
  );

  let llmResponse: string;
  try {
    llmResponse = await callLLM(systemPrompt, userPrompt);
  } catch (err: any) {
    return c.json({ error: `LLM call failed: ${err.message}` }, 502);
  }

  // Parse LLM response
  let plan: { groups: SprintGroup[]; reasoning: string };
  try {
    // Strip markdown fences if present
    const cleaned = llmResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    plan = JSON.parse(cleaned);
  } catch {
    return c.json({
      error: "Failed to parse LLM response as JSON",
      raw: llmResponse.slice(0, 2000),
    }, 502);
  }

  // Validate and enforce constraints
  if (!Array.isArray(plan.groups)) {
    return c.json({ error: "LLM returned invalid plan (no groups array)" }, 502);
  }

  // Enforce budget
  if (plan.groups.length > budget) {
    plan.groups = plan.groups.slice(0, budget);
  }

  // Calculate totals
  let totalTasks = 0;
  let totalTokens = 0;
  for (const group of plan.groups) {
    if (!Array.isArray(group.tasks)) group.tasks = [];
    group.totalTokens = group.tasks.reduce((sum, t) => sum + (t.estimatedTokens || estimateTokens(t.effort)), 0);
    totalTasks += group.tasks.length;
    totalTokens += group.totalTokens;
  }

  // Save to store
  const sprint = plannerStore.saveSprint({
    intent,
    budget,
    constraints,
    template: templateName,
    groups: plan.groups,
    totalTasks,
    totalTokens,
    reasoning: plan.reasoning || "",
  });

  emit("planner", "planner.sprint.created", {
    sprintId: sprint.id,
    intent,
    budget,
    totalTasks,
    totalTokens,
    template: templateName,
  }, "sprint-planner");

  // Deep-linked notification: sprint plan ready for review
  try {
    createDeepLinkedNotification({
      type: "update",
      title: `📋 Sprint plan ready (${totalTasks} tasks)`,
      body: `Intent: ${intent}\nBudget: ${budget} tokens`,
      priority: "normal",
      source: "sprint-planner",
      uiPath: "/ui/pm",
    });
  } catch {}

  return c.json(sprint, 201);
});

/**
 * GET /planner/analysis — Board health report
 */
plannerRoutes.get("/analysis", (c) => {
  const allTasks = boardStore.listTasks();
  const analysis = analyzeBoard(allTasks);

  return c.json({
    analysis,
    summary: summarizeAnalysis(analysis),
    generatedAt: new Date().toISOString(),
  });
});

/**
 * GET /planner/sprints — List past sprint plans
 */
plannerRoutes.get("/sprints", (c) => {
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const sprints = plannerStore.listSprints(Math.min(limit, 100));
  return c.json({ sprints, count: sprints.length });
});

/**
 * GET /planner/sprints/:id — Get a specific sprint plan
 */
plannerRoutes.get("/sprints/:id", (c) => {
  const sprint = plannerStore.getSprint(c.req.param("id"));
  if (!sprint) return c.json({ error: "sprint not found" }, 404);
  return c.json(sprint);
});

/**
 * GET /planner/templates — List available sprint templates
 */
plannerRoutes.get("/templates", (c) => {
  return c.json({ templates: listTemplates() });
});

/**
 * GET /planner/templates/:name — Get a specific template
 */
plannerRoutes.get("/templates/:name", (c) => {
  const template = getTemplate(c.req.param("name"));
  if (!template) return c.json({ error: "template not found" }, 404);
  return c.json(template);
});
