import { Hono } from "hono";
import crypto from "node:crypto";
import { JournalStore } from "../journal/store.js";
import { BoardStore } from "../board/store.js";
import { LogStore } from "../log/store.js";

const journalStore = new JournalStore();
const boardStore = new BoardStore();
const logStore = new LogStore();

export const twilioRoutes = new Hono();

/**
 * Validate Twilio X-Twilio-Signature header using HMAC-SHA1.
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  // Sort POST params by key and concatenate key+value
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join("");

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(data)
    .digest("base64");

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

/**
 * Build a TwiML response with a message body.
 */
function twiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(message)}</Message></Response>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface ParsedMessage {
  type: "journal" | "task" | "log";
  text: string;
}

/**
 * Parse SMS body into a typed message.
 * Prefixes: j:/journal:, t:/task:, l:/log:
 * Default: journal
 */
function parseMessage(body: string): ParsedMessage {
  const trimmed = body.trim();

  // Check prefixes (case-insensitive)
  const prefixMatch = trimmed.match(/^(j|journal|t|task|l|log):\s*(.*)/is);
  if (prefixMatch) {
    const prefix = prefixMatch[1].toLowerCase();
    const text = prefixMatch[2].trim();

    if (prefix === "j" || prefix === "journal") {
      return { type: "journal", text };
    }
    if (prefix === "t" || prefix === "task") {
      return { type: "task", text };
    }
    if (prefix === "l" || prefix === "log") {
      return { type: "log", text };
    }
  }

  // Default to journal
  return { type: "journal", text: trimmed };
}

// POST /twilio/webhook — Twilio SMS webhook
twilioRoutes.post("/webhook", async (c) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return c.text(twiml("Service not configured"), 503, {
      "Content-Type": "text/xml",
    });
  }

  // Parse form body
  const formData = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }

  // Validate X-Twilio-Signature
  const signature = c.req.header("X-Twilio-Signature") || "";
  const url =
    process.env.TWILIO_WEBHOOK_URL || new URL(c.req.url).toString();

  if (!validateTwilioSignature(authToken, signature, url, params)) {
    return c.text(twiml("Unauthorized"), 403, {
      "Content-Type": "text/xml",
    });
  }

  // Check phone allowlist
  const allowedNumbers = process.env.TWILIO_ALLOWED_NUMBERS;
  const from = params.From || "";
  if (allowedNumbers) {
    const allowed = allowedNumbers.split(",").map((n) => n.trim());
    if (!allowed.includes(from)) {
      return c.text(twiml("Not authorized"), 403, {
        "Content-Type": "text/xml",
      });
    }
  }

  const smsBody = params.Body || "";
  if (!smsBody.trim()) {
    return c.text(twiml("Empty message received"), 400, {
      "Content-Type": "text/xml",
    });
  }

  const parsed = parseMessage(smsBody);

  try {
    let responseText: string;

    switch (parsed.type) {
      case "journal": {
        const entry = journalStore.append({
          text: parsed.text,
          author: from,
          tags: ["sms"],
        });
        responseText = `Journal entry created (${entry.id})`;
        break;
      }
      case "task": {
        const task = boardStore.createTask({
          title: parsed.text,
          status: "open",
          createdBy: from,
          tags: ["sms"],
        });
        responseText = `Task created (${task.id})`;
        break;
      }
      case "log": {
        const entry = logStore.append({
          text: parsed.text,
          agent: from,
        });
        responseText = `Log entry created (${entry.id})`;
        break;
      }
    }

    return c.text(twiml(responseText), 200, {
      "Content-Type": "text/xml",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    return c.text(twiml(`Error: ${msg}`), 500, {
      "Content-Type": "text/xml",
    });
  }
});

export { parseMessage, validateTwilioSignature, twiml };
