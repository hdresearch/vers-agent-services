import { Hono } from "hono";
import crypto from "node:crypto";
import { JournalStore } from "../journal/store.js";
import { BoardStore } from "../board/store.js";
import { LogStore } from "../log/store.js";
import { bearerAuth } from "../auth.js";

const journalStore = new JournalStore();
const boardStore = new BoardStore();
const logStore = new LogStore();

export const twilioRoutes = new Hono();

// --- Helpers ---

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

// --- Twilio REST API helper ---

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

function getTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

interface SendSmsResult {
  ok: boolean;
  sid?: string;
  error?: string;
}

async function sendSms(
  config: TwilioConfig,
  to: string,
  body: string,
): Promise<SendSmsResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const auth = Buffer.from(
    `${config.accountSid}:${config.authToken}`,
  ).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: config.fromNumber,
      Body: body,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Twilio API ${res.status}: ${text}` };
  }

  const data = (await res.json()) as { sid?: string };
  return { ok: true, sid: data.sid };
}

// --- Routes ---

// GET /twilio/status — check if Twilio is configured
twilioRoutes.get("/status", (c) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const notifyNumber = process.env.TWILIO_NOTIFY_NUMBER;

  return c.json({
    configured: !!(authToken && accountSid && fromNumber),
    inbound: !!authToken,
    outbound: !!(accountSid && authToken && fromNumber),
    notify: !!(accountSid && authToken && fromNumber && notifyNumber),
    missing: [
      !accountSid && "TWILIO_ACCOUNT_SID",
      !authToken && "TWILIO_AUTH_TOKEN",
      !fromNumber && "TWILIO_PHONE_NUMBER",
      !notifyNumber && "TWILIO_NOTIFY_NUMBER",
    ].filter(Boolean),
  });
});

// POST /twilio/webhook — Twilio inbound SMS webhook (no bearer auth, uses Twilio signature)
twilioRoutes.post("/webhook", async (c) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return c.text(
      twiml("Service not configured — TWILIO_AUTH_TOKEN not set"),
      503,
      { "Content-Type": "text/xml" },
    );
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
      default: {
        responseText = "Unknown message type";
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

// --- Authenticated endpoints (internal fleet use) ---

// POST /twilio/send — send an SMS to any number
twilioRoutes.post("/send", bearerAuth(), async (c) => {
  const config = getTwilioConfig();
  if (!config) {
    return c.json(
      {
        error: "Twilio not configured",
        missing: [
          !process.env.TWILIO_ACCOUNT_SID && "TWILIO_ACCOUNT_SID",
          !process.env.TWILIO_AUTH_TOKEN && "TWILIO_AUTH_TOKEN",
          !process.env.TWILIO_PHONE_NUMBER && "TWILIO_PHONE_NUMBER",
        ].filter(Boolean),
      },
      503,
    );
  }

  let body: { to?: string; body?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.to || !body.body) {
    return c.json({ error: "Missing required fields: to, body" }, 400);
  }

  // Basic phone number validation
  if (!/^\+\d{10,15}$/.test(body.to)) {
    return c.json(
      { error: "Invalid phone number format — must be E.164 (e.g. +15551234567)" },
      400,
    );
  }

  if (body.body.length > 1600) {
    return c.json({ error: "Message too long (max 1600 chars)" }, 400);
  }

  const result = await sendSms(config, body.to, body.body);
  if (!result.ok) {
    return c.json({ error: result.error }, 502);
  }

  return c.json({ ok: true, sid: result.sid });
});

// POST /twilio/notify — send a notification to Noah's phone
twilioRoutes.post("/notify", bearerAuth(), async (c) => {
  const config = getTwilioConfig();
  const notifyNumber = process.env.TWILIO_NOTIFY_NUMBER;

  if (!config || !notifyNumber) {
    return c.json(
      {
        error: "Notification not configured",
        missing: [
          !process.env.TWILIO_ACCOUNT_SID && "TWILIO_ACCOUNT_SID",
          !process.env.TWILIO_AUTH_TOKEN && "TWILIO_AUTH_TOKEN",
          !process.env.TWILIO_PHONE_NUMBER && "TWILIO_PHONE_NUMBER",
          !notifyNumber && "TWILIO_NOTIFY_NUMBER",
        ].filter(Boolean),
      },
      503,
    );
  }

  let body: { message?: string; urgency?: "low" | "normal" | "high" };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.message) {
    return c.json({ error: "Missing required field: message" }, 400);
  }

  const urgency = body.urgency || "normal";

  // Format message with urgency prefix
  const prefix =
    urgency === "high"
      ? "🚨 "
      : urgency === "low"
        ? "📋 "
        : "📌 ";
  const text = `${prefix}${body.message}`;

  if (text.length > 1600) {
    return c.json({ error: "Message too long (max 1600 chars)" }, 400);
  }

  const result = await sendSms(config, notifyNumber, text);
  if (!result.ok) {
    return c.json({ error: result.error }, 502);
  }

  return c.json({ ok: true, sid: result.sid, urgency });
});

export { parseMessage, validateTwilioSignature, twiml, sendSms, getTwilioConfig };
