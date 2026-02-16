// ═══════════════════════════════════════════════════════════════════════════
// Analytics Query Engine — keyword-to-SQL template mapping
// Takes natural language questions, maps to DuckDB queries, returns structured data
// ═══════════════════════════════════════════════════════════════════════════

import { UsageStore } from "../usage/store.js";
import { BoardStore } from "../board/store.js";
import { RegistryStore } from "../registry/store.js";
import { FeedStore } from "../feed/store.js";

const usageStore = new UsageStore();
const boardStore = new BoardStore();
const registryStore = new RegistryStore();
const feedStore = new FeedStore();

interface QueryResult {
  answer: string;
  data?: {
    type: "table" | "number" | "timeseries" | "list";
    columns?: string[];
    rows?: any[][];
    value?: number;
    unit?: string;
    series?: { label: string; value: number }[];
  };
  sql?: string;
  chartHint?: "bar" | "line" | "donut" | "number" | "table";
}

interface QueryTemplate {
  keywords: string[];
  match: (q: string) => boolean;
  handler: (q: string) => Promise<QueryResult>;
}

// ─── Helpers ───

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO(): string {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toString();
}

function extractAgent(q: string): string | null {
  // Try to extract agent name from quotes or common patterns
  const quoted = q.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];
  const byAgent = q.match(/(?:agent|for)\s+(\S+)/i);
  if (byAgent) return byAgent[1];
  return null;
}

function extractRange(q: string): string {
  if (/today/i.test(q)) return "1d";
  if (/yesterday/i.test(q)) return "2d";
  if (/this\s*week|past\s*week|7\s*d/i.test(q)) return "7d";
  if (/this\s*month|30\s*d/i.test(q)) return "30d";
  if (/24\s*h/i.test(q)) return "1d";
  if (/48\s*h/i.test(q)) return "2d";
  const match = q.match(/(\d+)\s*(d|h)/i);
  if (match) return match[1] + match[2].toLowerCase();
  return "7d"; // default
}

function rangeToCutoff(range: string): string {
  const match = range.match(/^(\d+)(h|d)$/);
  if (!match) return new Date(Date.now() - 7 * 86400000).toISOString();
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === "h" ? value * 3600000 : value * 86400000;
  return new Date(Date.now() - ms).toISOString();
}

// ─── Query Templates ───

const templates: QueryTemplate[] = [
  // 1. Total tokens burned (today/range)
  {
    keywords: ["tokens", "burn", "burned", "total tokens", "how many tokens"],
    match: (q) => /(?:how\s+many\s+)?tokens?\s*(?:burn|burned|used|spent|consumed)/i.test(q) ||
                  /(?:total|burn|burned)\s*tokens/i.test(q) ||
                  /token\s*burn/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT COALESCE(SUM(tokens_total), 0) as total_tokens, ROUND(COALESCE(SUM(cost_total), 0), 2) as total_cost, COUNT(DISTINCT agent) as agents FROM sessions WHERE started_at >= $1`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      const r = rows[0] || { total_tokens: 0, total_cost: 0, agents: 0 };
      const tokens = Number(r.total_tokens);
      const cost = Number(r.total_cost);
      const agents = Number(r.agents);
      return {
        answer: `You burned ${formatTokens(tokens)} tokens ($${cost.toFixed(2)}) across ${agents} agents in the last ${range}.`,
        data: { type: "number", value: tokens, unit: "tokens" },
        sql,
        chartHint: "number",
      };
    },
  },

  // 2. Which agent burned the most
  {
    keywords: ["which agent", "top agent", "most tokens", "biggest burner", "highest"],
    match: (q) => /(?:which|what|top|biggest|highest)\s*agent/i.test(q) ||
                  /agent.*(?:most|burned|highest)/i.test(q) ||
                  /most\s*tokens/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost, COUNT(*) as sessions FROM sessions WHERE started_at >= $1 GROUP BY agent ORDER BY tokens DESC LIMIT 10`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No session data found.", chartHint: "table" };
      const top = rows[0];
      const columns = ["Agent", "Tokens", "Cost", "Sessions"];
      const tableRows = rows.map((r: any) => [r.agent, formatTokens(Number(r.tokens)), `$${Number(r.cost).toFixed(2)}`, Number(r.sessions)]);
      return {
        answer: `${top.agent} burned the most with ${formatTokens(Number(top.tokens))} tokens ($${Number(top.cost).toFixed(2)}).`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 3. Cost by day
  {
    keywords: ["cost by day", "cost over time", "daily cost", "cost trend", "spending"],
    match: (q) => /cost\s*(?:by|over|per|trend|history)\s*(?:day|time|date)?/i.test(q) ||
                  /daily\s*cost/i.test(q) ||
                  /spend(?:ing)?\s*(?:over|by|per)\s*(?:time|day)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT CAST(started_at AS DATE) as day, ROUND(SUM(cost_total), 2) as cost, SUM(tokens_total) as tokens FROM sessions WHERE started_at >= $1 GROUP BY day ORDER BY day`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No cost data found.", chartHint: "line" };
      const totalCost = rows.reduce((s: number, r: any) => s + Number(r.cost), 0);
      const columns = ["Day", "Cost", "Tokens"];
      const tableRows = rows.map((r: any) => {
        const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return [d, `$${Number(r.cost).toFixed(2)}`, formatTokens(Number(r.tokens))];
      });
      return {
        answer: `Total spending: $${totalCost.toFixed(2)} over ${rows.length} days.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "line",
      };
    },
  },

  // 4. Token burn by day
  {
    keywords: ["token burn by day", "tokens by day", "daily tokens", "tokens over time"],
    match: (q) => /tokens?\s*(?:burn\s*)?(?:by|over|per)\s*(?:day|time|date)/i.test(q) ||
                  /daily\s*(?:token|burn|usage)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT CAST(started_at AS DATE) as day, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost FROM sessions WHERE started_at >= $1 GROUP BY day ORDER BY day`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No token data found.", chartHint: "bar" };
      const columns = ["Day", "Tokens", "Cost"];
      const tableRows = rows.map((r: any) => {
        const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return [d, formatTokens(Number(r.tokens)), `$${Number(r.cost).toFixed(2)}`];
      });
      return {
        answer: `Token burn across ${rows.length} days.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 5. Cost by agent
  {
    keywords: ["cost by agent", "agent cost", "expensive agent"],
    match: (q) => /cost\s*(?:by|per|breakdown)\s*agent/i.test(q) ||
                  /agent\s*cost/i.test(q) ||
                  /(?:most\s+)?expensive\s*agent/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, ROUND(SUM(cost_total), 2) as cost, SUM(tokens_total) as tokens, COUNT(*) as sessions FROM sessions WHERE started_at >= $1 GROUP BY agent ORDER BY cost DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No agent cost data found.", chartHint: "bar" };
      const columns = ["Agent", "Cost", "Tokens", "Sessions"];
      const tableRows = rows.map((r: any) => [r.agent, `$${Number(r.cost).toFixed(2)}`, formatTokens(Number(r.tokens)), Number(r.sessions)]);
      return {
        answer: `Cost breakdown across ${rows.length} agents.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 6. Token growth rate / day-over-day
  {
    keywords: ["growth", "growth rate", "day over day", "trend"],
    match: (q) => /(?:token|cost)?\s*growth\s*rate/i.test(q) ||
                  /day\s*over\s*day/i.test(q) ||
                  /(?:compare|vs|versus)\s*yesterday/i.test(q) ||
                  /today\s*vs\s*yesterday/i.test(q),
    handler: async (q) => {
      const today = todayISO();
      const yesterday = yesterdayISO();
      const sql = `SELECT CAST(started_at AS DATE) as day, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost FROM sessions WHERE CAST(started_at AS DATE) >= $1 GROUP BY day ORDER BY day`;
      const rows = await usageStore.analyticsQuery(sql, [yesterday]);
      const todayRow = rows.find((r: any) => {
        const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return d === today;
      });
      const yesterRow = rows.find((r: any) => {
        const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return d === yesterday;
      });
      const todayTokens = todayRow ? Number(todayRow.tokens) : 0;
      const yesterTokens = yesterRow ? Number(yesterRow.tokens) : 0;
      const todayCost = todayRow ? Number(todayRow.cost) : 0;
      const yesterCost = yesterRow ? Number(yesterRow.cost) : 0;
      const pctChange = yesterTokens > 0 ? ((todayTokens - yesterTokens) / yesterTokens * 100).toFixed(1) : "N/A";
      const columns = ["Metric", "Today", "Yesterday", "Change"];
      const tableRows = [
        ["Tokens", formatTokens(todayTokens), formatTokens(yesterTokens), typeof pctChange === "string" && pctChange !== "N/A" ? pctChange + "%" : pctChange],
        ["Cost", `$${todayCost.toFixed(2)}`, `$${yesterCost.toFixed(2)}`, yesterCost > 0 ? ((todayCost - yesterCost) / yesterCost * 100).toFixed(1) + "%" : "N/A"],
      ];
      return {
        answer: `Today: ${formatTokens(todayTokens)} tokens ($${todayCost.toFixed(2)}). Yesterday: ${formatTokens(yesterTokens)} ($${yesterCost.toFixed(2)}). Change: ${pctChange}%.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "table",
      };
    },
  },

  // 7. Model breakdown
  {
    keywords: ["model", "model breakdown", "by model", "model usage"],
    match: (q) => /model\s*(?:breakdown|usage|split|distribution)/i.test(q) ||
                  /(?:by|per)\s*model/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT model, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost, COUNT(*) as sessions FROM sessions WHERE started_at >= $1 GROUP BY model ORDER BY tokens DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No model data found.", chartHint: "donut" };
      const columns = ["Model", "Tokens", "Cost", "Sessions"];
      const tableRows = rows.map((r: any) => [r.model, formatTokens(Number(r.tokens)), `$${Number(r.cost).toFixed(2)}`, Number(r.sessions)]);
      return {
        answer: `Model breakdown across ${rows.length} models.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "donut",
      };
    },
  },

  // 8. Sessions count / over time
  {
    keywords: ["sessions", "session count", "how many sessions"],
    match: (q) => /(?:how\s+many\s+)?sessions?\s*(?:count|total|over|by)?/i.test(q) ||
                  /session\s*(?:trend|history|daily)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT CAST(started_at AS DATE) as day, COUNT(*) as sessions, COUNT(DISTINCT agent) as agents FROM sessions WHERE started_at >= $1 GROUP BY day ORDER BY day`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      const total = rows.reduce((s: number, r: any) => s + Number(r.sessions), 0);
      const columns = ["Day", "Sessions", "Agents"];
      const tableRows = rows.map((r: any) => {
        const d = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return [d, Number(r.sessions), Number(r.agents)];
      });
      return {
        answer: `${total} sessions across ${rows.length} days.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 9. Input vs output tokens
  {
    keywords: ["input vs output", "input output", "token split", "token ratio"],
    match: (q) => /input\s*(?:vs\.?|versus|and)\s*output/i.test(q) ||
                  /token\s*(?:split|breakdown|ratio)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, SUM(tokens_input) as input_tokens, SUM(tokens_output) as output_tokens, SUM(tokens_total) as total_tokens FROM sessions WHERE started_at >= $1 GROUP BY agent ORDER BY total_tokens DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No token data found.", chartHint: "bar" };
      const columns = ["Agent", "Input", "Output", "Total"];
      const tableRows = rows.map((r: any) => [r.agent, formatTokens(Number(r.input_tokens)), formatTokens(Number(r.output_tokens)), formatTokens(Number(r.total_tokens))]);
      const totalInput = rows.reduce((s: number, r: any) => s + Number(r.input_tokens), 0);
      const totalOutput = rows.reduce((s: number, r: any) => s + Number(r.output_tokens), 0);
      return {
        answer: `Fleet-wide: ${formatTokens(totalInput)} input, ${formatTokens(totalOutput)} output tokens.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 10. Efficiency (tokens per turn)
  {
    keywords: ["efficiency", "tokens per turn", "cost per token"],
    match: (q) => /efficiency/i.test(q) ||
                  /(?:token|cost)\s*per\s*(?:turn|token)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, SUM(tokens_total) as tokens, SUM(turns) as turns, ROUND(SUM(cost_total), 2) as cost FROM sessions WHERE started_at >= $1 GROUP BY agent HAVING SUM(turns) > 0 ORDER BY (SUM(tokens_total) / SUM(turns)) DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No efficiency data found.", chartHint: "bar" };
      const columns = ["Agent", "Tokens/Turn", "Cost/Turn", "Turns"];
      const tableRows = rows.map((r: any) => {
        const tpt = Math.round(Number(r.tokens) / Number(r.turns));
        const cpt = (Number(r.cost) / Number(r.turns)).toFixed(4);
        return [r.agent, formatTokens(tpt), `$${cpt}`, Number(r.turns)];
      });
      return {
        answer: `Efficiency breakdown across ${rows.length} agents.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 11. Open tasks
  {
    keywords: ["tasks", "open tasks", "how many tasks", "board"],
    match: (q) => /(?:how\s+many\s+)?tasks?\s*(?:are\s+)?(?:open|pending|blocked)?/i.test(q) ||
                  /(?:open|pending|blocked)\s*tasks/i.test(q) ||
                  /board\s*(?:status|summary|overview)/i.test(q),
    handler: async (_q) => {
      const tasks = boardStore.listTasks();
      const byStatus: Record<string, number> = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      }
      const columns = ["Status", "Count"];
      const tableRows = Object.entries(byStatus).map(([s, c]) => [s, c]);
      return {
        answer: `${tasks.length} total tasks: ${Object.entries(byStatus).map(([s, c]) => `${c} ${s}`).join(", ")}.`,
        data: { type: "table", columns, rows: tableRows },
        chartHint: "bar",
      };
    },
  },

  // 12. Running agents / VMs
  {
    keywords: ["running agents", "agents running", "active agents", "vms", "registry"],
    match: (q) => /(?:what|which|how\s+many)?\s*agents?\s*(?:are\s+)?(?:running|active|online)/i.test(q) ||
                  /(?:running|active)\s*agents/i.test(q) ||
                  /(?:what|which)\s*vms/i.test(q) ||
                  /registry\s*(?:status|summary)?/i.test(q),
    handler: async (_q) => {
      const vms = registryStore.list();
      if (vms.length === 0) return { answer: "No VMs currently registered.", chartHint: "table" };
      const columns = ["Name", "Role", "Status", "Last Seen"];
      const tableRows = vms.map((v: any) => [v.name, v.role, v.status || "unknown", v.lastSeen || v.registeredAt]);
      return {
        answer: `${vms.length} VMs registered.`,
        data: { type: "table", columns, rows: tableRows },
        chartHint: "table",
      };
    },
  },

  // 13. Zombie events
  {
    keywords: ["zombie", "zombies", "zombie events"],
    match: (q) => /zombie/i.test(q),
    handler: async (_q) => {
      const events = feedStore.list({ type: "zombie_detected", limit: 20 });
      const confirmed = feedStore.list({ type: "zombie_confirmed", limit: 20 });
      const all = [...events, ...confirmed].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      if (all.length === 0) return { answer: "No zombie events found. Fleet is healthy!", chartHint: "table" };
      const columns = ["Type", "Agent", "Summary", "Time"];
      const tableRows = all.slice(0, 20).map((e: any) => [e.type, e.agent || "—", e.summary, e.timestamp]);
      return {
        answer: `${all.length} zombie events found (${events.length} detected, ${confirmed.length} confirmed).`,
        data: { type: "table", columns, rows: tableRows },
        chartHint: "table",
      };
    },
  },

  // 14. Recent feed events
  {
    keywords: ["feed", "events", "recent events", "activity"],
    match: (q) => /(?:recent|latest)\s*(?:feed\s*)?events?/i.test(q) ||
                  /(?:feed|activity)\s*(?:summary|recent|latest)?/i.test(q) ||
                  /show\s*(?:me\s+)?(?:the\s+)?(?:feed|events|activity)/i.test(q),
    handler: async (_q) => {
      const events = feedStore.list({ limit: 20 });
      if (events.length === 0) return { answer: "No recent feed events.", chartHint: "table" };
      const columns = ["Type", "Agent", "Summary", "Time"];
      const tableRows = events.map((e: any) => [e.type, e.agent || "—", e.summary?.slice(0, 80) || "—", e.timestamp]);
      return {
        answer: `${events.length} recent events.`,
        data: { type: "table", columns, rows: tableRows },
        chartHint: "table",
      };
    },
  },

  // 15. Agent detail
  {
    keywords: ["agent detail", "tell me about", "info on"],
    match: (q) => /(?:tell\s+me\s+about|info\s+(?:on|about)|detail\s+(?:on|for)|stats?\s+(?:for|on))\s+/i.test(q) ||
                  /^(?:about|info)\s+\S+/i.test(q),
    handler: async (q) => {
      const agent = extractAgent(q) || q.replace(/.*(?:about|for|on)\s+/i, "").trim();
      if (!agent) return { answer: "Please specify an agent name.", chartHint: "table" };
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, model, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost, SUM(turns) as turns, COUNT(*) as sessions, MIN(started_at) as first_seen, MAX(ended_at) as last_seen FROM sessions WHERE agent LIKE $1 AND started_at >= $2 GROUP BY agent, model ORDER BY tokens DESC`;
      const rows = await usageStore.analyticsQuery(sql, [`%${agent}%`, cutoff]);
      if (rows.length === 0) return { answer: `No data found for agent matching "${agent}".`, chartHint: "table" };
      const columns = ["Agent", "Model", "Tokens", "Cost", "Turns", "Sessions"];
      const tableRows = rows.map((r: any) => [r.agent, r.model, formatTokens(Number(r.tokens)), `$${Number(r.cost).toFixed(2)}`, Number(r.turns), Number(r.sessions)]);
      const total = rows.reduce((s: number, r: any) => s + Number(r.tokens), 0);
      return {
        answer: `Agent "${rows[0].agent}": ${formatTokens(total)} tokens, $${rows.reduce((s: number, r: any) => s + Number(r.cost), 0).toFixed(2)} cost, ${rows.reduce((s: number, r: any) => s + Number(r.sessions), 0)} sessions.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "table",
      };
    },
  },

  // 16. Cost breakdown (donut)
  {
    keywords: ["cost breakdown", "cost split", "where is money going"],
    match: (q) => /cost\s*(?:breakdown|split)/i.test(q) ||
                  /where\s*(?:is|are)\s*(?:the\s+)?(?:money|cost|spend)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, ROUND(SUM(cost_total), 2) as cost FROM sessions WHERE started_at >= $1 GROUP BY agent ORDER BY cost DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No cost data found.", chartHint: "donut" };
      const total = rows.reduce((s: number, r: any) => s + Number(r.cost), 0);
      const columns = ["Agent", "Cost", "% of Total"];
      const tableRows = rows.map((r: any) => [r.agent, `$${Number(r.cost).toFixed(2)}`, (Number(r.cost) / total * 100).toFixed(1) + "%"]);
      return {
        answer: `Total cost: $${total.toFixed(2)} across ${rows.length} agents.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "donut",
      };
    },
  },

  // 17. Turns by agent
  {
    keywords: ["turns", "turns by agent"],
    match: (q) => /turns?\s*(?:by|per)\s*agent/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, SUM(turns) as turns, SUM(tokens_total) as tokens FROM sessions WHERE started_at >= $1 GROUP BY agent ORDER BY turns DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No turns data found.", chartHint: "bar" };
      const columns = ["Agent", "Turns", "Tokens"];
      const tableRows = rows.map((r: any) => [r.agent, Number(r.turns), formatTokens(Number(r.tokens))]);
      return {
        answer: `Turns breakdown across ${rows.length} agents.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 18. Fleet overview / summary
  {
    keywords: ["overview", "summary", "dashboard", "fleet status"],
    match: (q) => /(?:overview|summary|dashboard|fleet\s*status)/i.test(q) ||
                  /^(?:show|give)\s+(?:me\s+)?(?:a\s+)?(?:summary|overview)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT COALESCE(SUM(tokens_total), 0) as tokens, ROUND(COALESCE(SUM(cost_total), 0), 2) as cost, COUNT(*) as sessions, COUNT(DISTINCT agent) as agents, COUNT(DISTINCT model) as models FROM sessions WHERE started_at >= $1`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      const r = rows[0] || { tokens: 0, cost: 0, sessions: 0, agents: 0, models: 0 };
      const tasks = boardStore.listTasks();
      const vms = registryStore.list();
      const openTasks = tasks.filter((t: any) => t.status === "open" || t.status === "in_progress").length;
      const columns = ["Metric", "Value"];
      const tableRows = [
        ["Total Tokens", formatTokens(Number(r.tokens))],
        ["Total Cost", `$${Number(r.cost).toFixed(2)}`],
        ["Sessions", Number(r.sessions)],
        ["Agents", Number(r.agents)],
        ["Models", Number(r.models)],
        ["Active Tasks", openTasks],
        ["Registered VMs", vms.length],
      ];
      return {
        answer: `Fleet: ${formatTokens(Number(r.tokens))} tokens, $${Number(r.cost).toFixed(2)} cost, ${Number(r.sessions)} sessions, ${Number(r.agents)} agents, ${openTasks} active tasks, ${vms.length} VMs.`,
        data: { type: "table", columns, rows: tableRows },
        chartHint: "table",
      };
    },
  },

  // 19. Cache utilization
  {
    keywords: ["cache", "cache hit", "cache usage", "cache rate"],
    match: (q) => /cache\s*(?:hit|usage|util|rate|ratio|read|write)/i.test(q),
    handler: async (q) => {
      const range = extractRange(q);
      const cutoff = rangeToCutoff(range);
      const sql = `SELECT agent, SUM(tokens_input) as input, SUM(tokens_cache_read) as cache_read, SUM(tokens_cache_write) as cache_write, SUM(tokens_total) as total FROM sessions WHERE started_at >= $1 GROUP BY agent ORDER BY cache_read DESC`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No cache data found.", chartHint: "bar" };
      const columns = ["Agent", "Cache Read", "Cache Write", "Input", "Cache Rate"];
      const tableRows = rows.map((r: any) => {
        const cacheRead = Number(r.cache_read);
        const input = Number(r.input);
        const rate = input > 0 ? (cacheRead / (input + cacheRead) * 100).toFixed(1) + "%" : "0%";
        return [r.agent, formatTokens(cacheRead), formatTokens(Number(r.cache_write)), formatTokens(input), rate];
      });
      return {
        answer: `Cache utilization across ${rows.length} agents.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },

  // 20. Hourly breakdown
  {
    keywords: ["hourly", "by hour", "per hour"],
    match: (q) => /(?:by|per)\s*hour/i.test(q) || /hourly/i.test(q),
    handler: async (q) => {
      const cutoff = rangeToCutoff("1d");
      const sql = `SELECT EXTRACT(HOUR FROM started_at) as hour, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost, COUNT(*) as sessions FROM sessions WHERE started_at >= $1 GROUP BY hour ORDER BY hour`;
      const rows = await usageStore.analyticsQuery(sql, [cutoff]);
      if (rows.length === 0) return { answer: "No hourly data found.", chartHint: "bar" };
      const columns = ["Hour", "Tokens", "Cost", "Sessions"];
      const tableRows = rows.map((r: any) => [`${Number(r.hour).toString().padStart(2, "0")}:00`, formatTokens(Number(r.tokens)), `$${Number(r.cost).toFixed(2)}`, Number(r.sessions)]);
      return {
        answer: `Hourly breakdown for today.`,
        data: { type: "table", columns, rows: tableRows },
        sql,
        chartHint: "bar",
      };
    },
  },
];

// ─── Query Router ───

export async function processAnalyticsQuery(question: string): Promise<QueryResult> {
  const q = question.trim();

  if (!q) {
    return { answer: "Please ask a question about your fleet metrics." };
  }

  if (/^help$/i.test(q)) {
    return {
      answer: "Available queries:\n" +
        "• \"how many tokens did we burn today?\"\n" +
        "• \"which agent burned the most?\"\n" +
        "• \"cost by day\" / \"cost over time\"\n" +
        "• \"token burn by day\"\n" +
        "• \"cost by agent\"\n" +
        "• \"today vs yesterday\" / \"growth rate\"\n" +
        "• \"model breakdown\"\n" +
        "• \"sessions over time\"\n" +
        "• \"input vs output\"\n" +
        "• \"efficiency\" / \"tokens per turn\"\n" +
        "• \"how many tasks are open?\"\n" +
        "• \"what agents are running?\"\n" +
        "• \"show me zombie events\"\n" +
        "• \"recent events\" / \"feed\"\n" +
        "• \"tell me about <agent>\"\n" +
        "• \"cost breakdown\"\n" +
        "• \"turns by agent\"\n" +
        "• \"overview\" / \"summary\"\n" +
        "• \"cache utilization\"\n" +
        "• \"hourly breakdown\"",
    };
  }

  // Try each template
  for (const template of templates) {
    if (template.match(q)) {
      try {
        return await template.handler(q);
      } catch (e: any) {
        return {
          answer: `Query error: ${e.message}`,
        };
      }
    }
  }

  // No match — suggest
  return {
    answer: `I couldn't understand "${q}". Try:\n• "how many tokens burned today?"\n• "which agent burned the most?"\n• "cost by day"\n• "overview"\n• "help" for full list`,
  };
}
