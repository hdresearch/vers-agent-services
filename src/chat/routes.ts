import { Hono } from "hono";

export const chatRoutes = new Hono();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CHAT_MODEL || "claude-sonnet-4-20250514";

// Gather infra context from local APIs
async function gatherContext(port: number, authToken: string): Promise<string> {
  const headers = { Authorization: `Bearer ${authToken}` };
  const base = `http://127.0.0.1:${port}`;

  const fetches = [
    fetch(`${base}/board/tasks`, { headers }).then(r => r.json()).catch(() => ({ tasks: [] })),
    fetch(`${base}/feed/events?limit=20`, { headers }).then(r => r.json()).catch(() => ({ events: [] })),
    fetch(`${base}/registry/vms`, { headers }).then(r => r.json()).catch(() => ({ vms: [] })),
    fetch(`${base}/log?last=6h`, { headers }).then(r => r.json()).catch(() => ({ entries: [] })),
    fetch(`${base}/usage?range=7d`, { headers }).then(r => r.json()).catch(() => ({})),
  ];

  const [board, feed, registry, log, usage] = await Promise.all(fetches);

  const sections: string[] = [];

  const tasks = board.tasks || [];
  if (tasks.length > 0) {
    sections.push(`## Board (${tasks.length} tasks)\n${tasks.map((t: any) =>
      `- [${t.status}] ${t.title}${t.assignee ? ` (@${t.assignee})` : ''}${t.tags?.length ? ` [${t.tags.join(', ')}]` : ''}`
    ).join('\n')}`);
  }

  const events = Array.isArray(feed) ? feed : (feed.events || []);
  if (events.length > 0) {
    sections.push(`## Recent Feed (last ${events.length} events)\n${events.slice(0, 15).map((e: any) =>
      `- [${e.type}] ${e.agent}: ${e.summary}`
    ).join('\n')}`);
  }

  const vms = registry.vms || [];
  if (vms.length > 0) {
    sections.push(`## Registry (${vms.length} VMs)\n${vms.map((v: any) =>
      `- ${v.name || v.id} (${v.role}) — ${v.status || 'unknown'}`
    ).join('\n')}`);
  }

  const entries = log.entries || [];
  if (entries.length > 0) {
    sections.push(`## Work Log (last 6h, ${entries.length} entries)\n${entries.slice(-10).map((e: any) =>
      `- ${e.agent || '?'}: ${e.text}`
    ).join('\n')}`);
  }

  if (usage.total) {
    sections.push(`## Usage (7d)\n- Total tokens: ${usage.total?.tokens?.toLocaleString() || '?'}\n- Total cost: $${usage.total?.cost?.toFixed(2) || '?'}\n- Sessions: ${usage.total?.sessions || '?'}`);
  }

  return sections.length > 0
    ? `# Current Infrastructure State\n\n${sections.join('\n\n')}`
    : 'No infrastructure data available yet.';
}

// POST /chat — streaming chat endpoint
chatRoutes.post("/", async (c) => {
  if (!ANTHROPIC_API_KEY) {
    return c.json({ error: "ANTHROPIC_API_KEY not set on server" }, 500);
  }

  const body = await c.req.json();
  const messages: Array<{ role: string; content: string }> = body.messages || [];
  const includeContext = body.includeContext !== false; // default true

  if (!messages.length) {
    return c.json({ error: "messages array required" }, 400);
  }

  // Build system prompt with infra context
  const port = parseInt(process.env.PORT || "3000", 10);
  const authToken = process.env.VERS_AUTH_TOKEN || "";

  let systemPrompt = `You are an AI assistant embedded in the Agent Services dashboard — an infrastructure control plane for managing AI agent swarms on the Vers platform.

You have access to real-time data about the user's infrastructure: tasks on the board, activity feed events, registered VMs, work logs, and usage metrics. Use this context to give informed, specific answers.

Be concise and direct. Use markdown formatting. When referencing tasks, VMs, or agents, use their actual names/IDs from the context.`;

  if (includeContext) {
    try {
      const context = await gatherContext(port, authToken);
      systemPrompt += `\n\n${context}`;
    } catch (e) {
      systemPrompt += `\n\n(Failed to gather infra context: ${e})`;
    }
  }

  // Stream from Anthropic
  const anthropicBody = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
  };

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.json({ error: `Anthropic API error: ${resp.status}`, details: errText }, 502);
    }

    // Pipe SSE stream through
    const readable = new ReadableStream({
      async start(controller) {
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          // Stream closed
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    return c.json({ error: "Failed to reach Anthropic API", details: String(e) }, 502);
  }
});
