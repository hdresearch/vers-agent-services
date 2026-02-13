import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import crypto from "node:crypto";
import { parseMessage, validateTwilioSignature, twiml, twilioRoutes } from "../routes.js";

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
    return crypto.createHmac("sha1", authToken).update(data).digest("base64");
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
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(false);
  });
});

describe("twiml", () => {
  it("returns valid TwiML XML", () => {
    const xml = twiml("Hello there");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Response><Message>Hello there</Message></Response>");
  });

  it("escapes XML special characters", () => {
    const xml = twiml('Test <b>"quotes"</b> & stuff');
    expect(xml).toContain("&lt;b&gt;&quot;quotes&quot;&lt;/b&gt; &amp; stuff");
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
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
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
    // Re-import to pick up fresh env
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Body=hello&From=%2B15551234567",
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("not configured");
  });

  it("rejects invalid signature with 403", async () => {
    const { res, text } = await sendSMS("hello", "+15551234567", {}, {
      signature: "invalidsignature",
    });
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
