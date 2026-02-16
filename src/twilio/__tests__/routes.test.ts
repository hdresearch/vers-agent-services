import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import crypto from "node:crypto";
import {
  parseMessage,
  validateTwilioSignature,
  twiml,
} from "../routes.js";

// --- Unit tests ---

describe("parseMessage", () => {
  it("defaults to journal for unprefixed text", () => {
    expect(parseMessage("Hello world")).toEqual({
      type: "journal",
      text: "Hello world",
    });
  });

  it("parses j: prefix as journal", () => {
    expect(parseMessage("j: feeling good today")).toEqual({
      type: "journal",
      text: "feeling good today",
    });
  });

  it("parses journal: prefix as journal", () => {
    expect(parseMessage("journal: deep thoughts")).toEqual({
      type: "journal",
      text: "deep thoughts",
    });
  });

  it("parses t: prefix as task", () => {
    expect(parseMessage("t: fix the build")).toEqual({
      type: "task",
      text: "fix the build",
    });
  });

  it("parses task: prefix as task", () => {
    expect(parseMessage("task: deploy to staging")).toEqual({
      type: "task",
      text: "deploy to staging",
    });
  });

  it("parses l: prefix as log", () => {
    expect(parseMessage("l: deployed v2.1")).toEqual({
      type: "log",
      text: "deployed v2.1",
    });
  });

  it("parses log: prefix as log", () => {
    expect(parseMessage("log: server restarted")).toEqual({
      type: "log",
      text: "server restarted",
    });
  });

  it("is case-insensitive for prefixes", () => {
    expect(parseMessage("T: uppercase task")).toEqual({
      type: "task",
      text: "uppercase task",
    });
    expect(parseMessage("JOURNAL: loud entry")).toEqual({
      type: "journal",
      text: "loud entry",
    });
  });

  it("trims whitespace", () => {
    expect(parseMessage("  j:  spaced out  ")).toEqual({
      type: "journal",
      text: "spaced out",
    });
  });
});

describe("validateTwilioSignature", () => {
  const authToken = "test-auth-token-12345";

  function sign(url: string, params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort();
    const data = url + sortedKeys.map((k) => k + params[k]).join("");
    return crypto
      .createHmac("sha1", authToken)
      .update(data)
      .digest("base64");
  }

  it("accepts a valid signature", () => {
    const url = "https://example.com/twilio/webhook";
    const params = { Body: "hello", From: "+15551234567" };
    const sig = sign(url, params);
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const url = "https://example.com/twilio/webhook";
    const params = { Body: "hello", From: "+15551234567" };
    expect(
      validateTwilioSignature(authToken, "badsig", url, params),
    ).toBe(false);
  });

  it("rejects when params are tampered", () => {
    const url = "https://example.com/twilio/webhook";
    const params = { Body: "hello", From: "+15551234567" };
    const sig = sign(url, params);
    params.Body = "tampered";
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(
      false,
    );
  });
});

describe("twiml", () => {
  it("returns valid TwiML XML", () => {
    const xml = twiml("Hello there");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      "<Response><Message>Hello there</Message></Response>",
    );
  });

  it("escapes XML special characters", () => {
    const xml = twiml('Test <b>"quotes"</b> & stuff');
    expect(xml).toContain(
      "&lt;b&gt;&quot;quotes&quot;&lt;/b&gt; &amp; stuff",
    );
  });
});

// --- Integration tests ---

describe("POST /twilio/webhook", () => {
  const AUTH_TOKEN = "test-twilio-auth-token";
  const WEBHOOK_URL = "https://example.com/twilio/webhook";

  function sign(url: string, params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort();
    const data = url + sortedKeys.map((k) => k + params[k]).join("");
    return crypto
      .createHmac("sha1", AUTH_TOKEN)
      .update(data)
      .digest("base64");
  }

  function buildFormBody(params: Record<string, string>): string {
    return Object.entries(params)
      .map(
        ([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
      )
      .join("&");
  }

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_WEBHOOK_URL = WEBHOOK_URL;
    delete process.env.TWILIO_ALLOWED_NUMBERS;
  });

  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WEBHOOK_URL;
    delete process.env.TWILIO_ALLOWED_NUMBERS;
  });

  async function sendSMS(
    body: string,
    from = "+15551234567",
    extraParams: Record<string, string> = {},
    opts: { signature?: string } = {},
  ) {
    const app = new Hono();
    const { twilioRoutes: routes } = await import("../routes.js");
    app.route("/twilio", routes);

    const params: Record<string, string> = {
      Body: body,
      From: from,
      To: "+15559876543",
      ...extraParams,
    };

    const sig = opts.signature ?? sign(WEBHOOK_URL, params);

    const res = await app.request("/twilio/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": sig,
      },
      body: buildFormBody(params),
    });

    return { res, text: await res.text() };
  }

  it("creates a journal entry for unprefixed message", async () => {
    const { res, text } = await sendSMS("Feeling productive today");
    expect(res.status).toBe(200);
    expect(text).toContain("Journal entry created");
    expect(text).toContain("<Response>");
  });

  it("creates a journal entry for j: prefix", async () => {
    const { res, text } = await sendSMS("j: morning reflection");
    expect(res.status).toBe(200);
    expect(text).toContain("Journal entry created");
  });

  it("creates a journal entry for journal: prefix", async () => {
    const { res, text } = await sendSMS("journal: evening thoughts");
    expect(res.status).toBe(200);
    expect(text).toContain("Journal entry created");
  });

  it("creates a task for t: prefix", async () => {
    const { res, text } = await sendSMS("t: fix the login page");
    expect(res.status).toBe(200);
    expect(text).toContain("Task created");
  });

  it("creates a task for task: prefix", async () => {
    const { res, text } = await sendSMS("task: review PR #42");
    expect(res.status).toBe(200);
    expect(text).toContain("Task created");
  });

  it("creates a log entry for l: prefix", async () => {
    const { res, text } = await sendSMS("l: deployed to production");
    expect(res.status).toBe(200);
    expect(text).toContain("Log entry created");
  });

  it("creates a log entry for log: prefix", async () => {
    const { res, text } = await sendSMS("log: server maintenance complete");
    expect(res.status).toBe(200);
    expect(text).toContain("Log entry created");
  });

  it("returns 503 when TWILIO_AUTH_TOKEN not set", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const app = new Hono();
    const { twilioRoutes: routes } = await import("../routes.js");
    app.route("/twilio", routes);

    const res = await app.request("/twilio/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "Body=hello&From=%2B15551234567",
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("not configured");
  });

  it("rejects invalid signature with 403", async () => {
    const { res, text } = await sendSMS(
      "hello",
      "+15551234567",
      {},
      { signature: "invalidsignature" },
    );
    expect(res.status).toBe(403);
    expect(text).toContain("Unauthorized");
  });

  it("rejects disallowed phone numbers", async () => {
    process.env.TWILIO_ALLOWED_NUMBERS = "+15559999999,+15558888888";
    const { res, text } = await sendSMS("hello", "+15551234567");
    expect(res.status).toBe(403);
    expect(text).toContain("Not authorized");
  });

  it("allows phone numbers in allowlist", async () => {
    process.env.TWILIO_ALLOWED_NUMBERS = "+15551234567,+15559999999";
    const { res, text } = await sendSMS("hello", "+15551234567");
    expect(res.status).toBe(200);
    expect(text).toContain("Journal entry created");
  });

  it("returns TwiML XML content type", async () => {
    const { res } = await sendSMS("hello");
    expect(res.headers.get("Content-Type")).toContain("text/xml");
  });

  it("handles empty message body", async () => {
    const { res, text } = await sendSMS("   ");
    expect(res.status).toBe(400);
    expect(text).toContain("Empty message");
  });
});

// --- Outbound SMS tests ---

describe("POST /twilio/send", () => {
  const BEARER_TOKEN = "test-bearer-token";

  beforeEach(() => {
    process.env.VERS_AUTH_TOKEN = BEARER_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
    process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
    process.env.TWILIO_PHONE_NUMBER = "+15550001111";
  });

  afterEach(() => {
    delete process.env.VERS_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    vi.restoreAllMocks();
  });

  async function callSend(
    body: Record<string, unknown>,
    token = BEARER_TOKEN,
  ) {
    const app = new Hono();
    const { twilioRoutes: routes } = await import("../routes.js");
    app.route("/twilio", routes);

    const res = await app.request("/twilio/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  }

  it("returns 401 without auth token", async () => {
    const app = new Hono();
    const { twilioRoutes: routes } = await import("../routes.js");
    app.route("/twilio", routes);

    const res = await app.request("/twilio/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+15551234567", body: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 503 when Twilio not configured", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const { res, json } = await callSend({
      to: "+15551234567",
      body: "test",
    });
    expect(res.status).toBe(503);
    expect(json.error).toContain("not configured");
    expect(json.missing).toContain("TWILIO_ACCOUNT_SID");
  });

  it("returns 400 for missing fields", async () => {
    const { res, json } = await callSend({ to: "+15551234567" });
    expect(res.status).toBe(400);
    expect(json.error).toContain("Missing required fields");
  });

  it("validates E.164 phone number format", async () => {
    const { res, json } = await callSend({
      to: "not-a-number",
      body: "test",
    });
    expect(res.status).toBe(400);
    expect(json.error).toContain("Invalid phone number");
  });

  it("rejects messages over 1600 chars", async () => {
    const { res, json } = await callSend({
      to: "+15551234567",
      body: "x".repeat(1601),
    });
    expect(res.status).toBe(400);
    expect(json.error).toContain("too long");
  });

  it("sends SMS via Twilio API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: "SM_test_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { res, json } = await callSend({
      to: "+15551234567",
      body: "hello from the hive",
    });

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sid).toBe("SM_test_123");

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("AC_test_sid");
    expect(url).toContain("Messages.json");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.body.toString()).toContain("To=%2B15551234567");
    expect(opts.body.toString()).toContain(
      "Body=hello+from+the+hive",
    );
  });

  it("returns 502 on Twilio API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"message": "Invalid phone number"}',
    });
    vi.stubGlobal("fetch", mockFetch);

    const { res, json } = await callSend({
      to: "+15551234567",
      body: "test",
    });

    expect(res.status).toBe(502);
    expect(json.error).toContain("Twilio API 400");
  });
});

// --- Notify endpoint tests ---

describe("POST /twilio/notify", () => {
  const BEARER_TOKEN = "test-bearer-token";

  beforeEach(() => {
    process.env.VERS_AUTH_TOKEN = BEARER_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
    process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
    process.env.TWILIO_PHONE_NUMBER = "+15550001111";
    process.env.TWILIO_NOTIFY_NUMBER = "+15559998888";
  });

  afterEach(() => {
    delete process.env.VERS_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_NOTIFY_NUMBER;
    vi.restoreAllMocks();
  });

  async function callNotify(
    body: Record<string, unknown>,
    token = BEARER_TOKEN,
  ) {
    const app = new Hono();
    const { twilioRoutes: routes } = await import("../routes.js");
    app.route("/twilio", routes);

    const res = await app.request("/twilio/notify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  }

  it("returns 503 when TWILIO_NOTIFY_NUMBER not set", async () => {
    delete process.env.TWILIO_NOTIFY_NUMBER;
    const { res, json } = await callNotify({ message: "test" });
    expect(res.status).toBe(503);
    expect(json.error).toContain("not configured");
  });

  it("returns 400 for missing message", async () => {
    const { res, json } = await callNotify({});
    expect(res.status).toBe(400);
    expect(json.error).toContain("Missing required field");
  });

  it("sends notification with default urgency", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: "SM_notify_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { res, json } = await callNotify({
      message: "Task completed: fix the build",
    });

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.urgency).toBe("normal");

    // Check the message includes the prefix
    const body = mockFetch.mock.calls[0][1].body.toString();
    expect(body).toContain(encodeURIComponent("📌"));
    expect(body).toContain("To=%2B15559998888");
  });

  it("sends high urgency notification with 🚨 prefix", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: "SM_urgent_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { res, json } = await callNotify({
      message: "Zombie VM detected!",
      urgency: "high",
    });

    expect(res.status).toBe(200);
    expect(json.urgency).toBe("high");
    const body = mockFetch.mock.calls[0][1].body.toString();
    expect(body).toContain(encodeURIComponent("🚨"));
  });

  it("sends low urgency notification with 📋 prefix", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: "SM_low_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { res, json } = await callNotify({
      message: "Daily summary ready",
      urgency: "low",
    });

    expect(res.status).toBe(200);
    expect(json.urgency).toBe("low");
    const body = mockFetch.mock.calls[0][1].body.toString();
    expect(body).toContain(encodeURIComponent("📋"));
  });
});

// --- Status endpoint tests ---

describe("GET /twilio/status", () => {
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_NOTIFY_NUMBER;
  });

  async function getStatus() {
    const app = new Hono();
    const { twilioRoutes: routes } = await import("../routes.js");
    app.route("/twilio", routes);

    const res = await app.request("/twilio/status");
    return { res, json: await res.json() };
  }

  it("shows unconfigured state when no env vars set", async () => {
    const { json } = await getStatus();
    expect(json.configured).toBe(false);
    expect(json.inbound).toBe(false);
    expect(json.outbound).toBe(false);
    expect(json.notify).toBe(false);
    expect(json.missing.length).toBeGreaterThan(0);
  });

  it("shows configured state when all env vars set", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test";
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_PHONE_NUMBER = "+15550001111";
    process.env.TWILIO_NOTIFY_NUMBER = "+15559998888";

    const { json } = await getStatus();
    expect(json.configured).toBe(true);
    expect(json.inbound).toBe(true);
    expect(json.outbound).toBe(true);
    expect(json.notify).toBe(true);
  });

  it("shows partial config (inbound only)", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test";

    const { json } = await getStatus();
    expect(json.configured).toBe(false);
    expect(json.inbound).toBe(true);
    expect(json.outbound).toBe(false);
  });
});
