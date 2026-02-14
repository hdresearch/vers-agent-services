/**
 * Pi extension definition for gossip tools.
 * This is the content that gets published to the extension store.
 */

export const GOSSIP_EXTENSION_NAME = "gossip-tools";
export const GOSSIP_EXTENSION_DESCRIPTION =
  "Agent-to-agent messaging tools — send, check inbox, reply, and broadcast messages through the gossip service.";

export const GOSSIP_EXTENSION_CONTENT = `// Gossip tools for agent-to-agent communication
// These tools connect to the vers-agent-services gossip endpoint.

const GOSSIP_BASE = process.env.VERS_AGENT_SERVICES_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.VERS_AUTH_TOKEN || "";

async function gossipFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(\`\${GOSSIP_BASE}/gossip\${path}\`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": \`Bearer \${AUTH_TOKEN}\`,
      ...opts.headers,
    },
  });
  return res.json();
}

// Tool: gossip_send
// Send a direct message to another agent
export async function gossip_send(params: {
  from: string;
  to: string;
  type: "request" | "inform" | "alert" | "question";
  subject: string;
  body: string;
  priority?: "low" | "normal" | "high" | "urgent";
}) {
  return gossipFetch("/messages", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// Tool: gossip_check
// Check your inbox for messages
export async function gossip_check(params: {
  agent: string;
  unreadOnly?: boolean;
  limit?: number;
}) {
  const qs = new URLSearchParams({ to: params.agent });
  if (params.unreadOnly) qs.set("unread", "true");
  if (params.limit) qs.set("limit", String(params.limit));
  return gossipFetch(\`/messages?\${qs}\`);
}

// Tool: gossip_reply
// Reply to a specific message (continues the thread)
export async function gossip_reply(params: {
  from: string;
  replyTo: string;
  body: string;
  priority?: "low" | "normal" | "high" | "urgent";
}) {
  return gossipFetch("/messages", {
    method: "POST",
    body: JSON.stringify({
      from: params.from,
      to: "", // will be filled from original message context
      type: "reply",
      subject: "re:",
      body: params.body,
      priority: params.priority || "normal",
      replyTo: params.replyTo,
    }),
  });
}

// Tool: gossip_broadcast
// Broadcast a message to all agents
export async function gossip_broadcast(params: {
  from: string;
  type: "inform" | "alert" | "question";
  subject: string;
  body: string;
  priority?: "low" | "normal" | "high" | "urgent";
}) {
  return gossipFetch("/broadcast", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
`;

/**
 * Tool definitions for pi extension manifest.
 * These describe the tools for the LLM to understand and invoke.
 */
export const GOSSIP_TOOL_DEFINITIONS = [
  {
    name: "gossip_send",
    description: "Send a direct message to another agent through the gossip service.",
    parameters: {
      type: "object",
      required: ["from", "to", "type", "subject", "body"],
      properties: {
        from: { type: "string", description: "Your agent name" },
        to: { type: "string", description: "Target agent name" },
        type: { type: "string", enum: ["request", "inform", "alert", "question"], description: "Message type" },
        subject: { type: "string", description: "Message subject" },
        body: { type: "string", description: "Message body" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Message priority" },
      },
    },
  },
  {
    name: "gossip_check",
    description: "Check your inbox for messages from other agents.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: { type: "string", description: "Your agent name to check inbox for" },
        unreadOnly: { type: "boolean", description: "Only show unread messages" },
        limit: { type: "number", description: "Max messages to return" },
      },
    },
  },
  {
    name: "gossip_reply",
    description: "Reply to a specific message, continuing its thread.",
    parameters: {
      type: "object",
      required: ["from", "replyTo", "body"],
      properties: {
        from: { type: "string", description: "Your agent name" },
        replyTo: { type: "string", description: "Message ID to reply to" },
        body: { type: "string", description: "Reply body" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Message priority" },
      },
    },
  },
  {
    name: "gossip_broadcast",
    description: "Broadcast a message to all agents in the fleet.",
    parameters: {
      type: "object",
      required: ["from", "type", "subject", "body"],
      properties: {
        from: { type: "string", description: "Your agent name" },
        type: { type: "string", enum: ["inform", "alert", "question"], description: "Message type" },
        subject: { type: "string", description: "Broadcast subject" },
        body: { type: "string", description: "Broadcast body" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Message priority" },
      },
    },
  },
];
