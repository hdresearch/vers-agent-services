import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { parsePushEvent, parsePullRequestEvent } from "../routes.js";
import { formatPRComment, type CIResult } from "../ci-runner.js";

// ─── Payload Factories ───────────────────────────────────────────────

function makePushPayload(overrides: Record<string, any> = {}) {
  return {
    ref: "refs/heads/main",
    after: "abc123def456abc123def456abc123def456abc1",
    commits: [{ id: "abc123def456abc123def456abc123def456abc1", message: "test commit" }],
    repository: {
      name: "vers-agent-services",
      clone_url: "https://gitea.example.com/hdresearch/vers-agent-services.git",
      owner: { login: "hdresearch", username: "hdresearch" },
    },
    ...overrides,
  };
}

function makePRPayload(overrides: Record<string, any> = {}) {
  return {
    action: "opened",
    pull_request: {
      number: 42,
      head: {
        sha: "def456abc123def456abc123def456abc123def4",
        ref: "feat/cool-feature",
      },
    },
    repository: {
      name: "vers-agent-services",
      clone_url: "https://gitea.example.com/hdresearch/vers-agent-services.git",
      owner: { login: "hdresearch", username: "hdresearch" },
    },
    ...overrides,
  };
}

// ─── Push Event Parsing ──────────────────────────────────────────────

describe("parsePushEvent", () => {
  it("parses a valid push event", () => {
    const result = parsePushEvent(makePushPayload());
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("hdresearch");
    expect(result!.repo).toBe("vers-agent-services");
    expect(result!.sha).toBe("abc123def456abc123def456abc123def456abc1");
    expect(result!.branch).toBe("main");
    expect(result!.cloneUrl).toBe("https://gitea.example.com/hdresearch/vers-agent-services.git");
    expect(result!.prNumber).toBeUndefined();
  });

  it("extracts branch from ref", () => {
    const result = parsePushEvent(makePushPayload({ ref: "refs/heads/feat/ci-pipeline" }));
    expect(result!.branch).toBe("feat/ci-pipeline");
  });

  it("returns null for delete events (all-zero SHA)", () => {
    const result = parsePushEvent(makePushPayload({ after: "0000000000000000000000000000000000000000" }));
    expect(result).toBeNull();
  });

  it("returns null when ref is missing", () => {
    const result = parsePushEvent(makePushPayload({ ref: "" }));
    expect(result).toBeNull();
  });

  it("returns null when repository is missing", () => {
    const result = parsePushEvent(makePushPayload({ repository: undefined }));
    expect(result).toBeNull();
  });

  it("returns null when owner is missing", () => {
    const payload = makePushPayload();
    payload.repository.owner = { login: "", username: "" };
    const result = parsePushEvent(payload);
    expect(result).toBeNull();
  });
});

// ─── Pull Request Event Parsing ──────────────────────────────────────

describe("parsePullRequestEvent", () => {
  it("parses a valid PR opened event", () => {
    const result = parsePullRequestEvent(makePRPayload());
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("hdresearch");
    expect(result!.repo).toBe("vers-agent-services");
    expect(result!.sha).toBe("def456abc123def456abc123def456abc123def4");
    expect(result!.branch).toBe("feat/cool-feature");
    expect(result!.prNumber).toBe(42);
  });

  it("parses synchronize action", () => {
    const result = parsePullRequestEvent(makePRPayload({ action: "synchronize" }));
    expect(result).not.toBeNull();
  });

  it("parses reopened action", () => {
    const result = parsePullRequestEvent(makePRPayload({ action: "reopened" }));
    expect(result).not.toBeNull();
  });

  it("ignores closed action", () => {
    const result = parsePullRequestEvent(makePRPayload({ action: "closed" }));
    expect(result).toBeNull();
  });

  it("ignores labeled action", () => {
    const result = parsePullRequestEvent(makePRPayload({ action: "labeled" }));
    expect(result).toBeNull();
  });

  it("returns null when pull_request is missing", () => {
    const result = parsePullRequestEvent(makePRPayload({ pull_request: undefined }));
    expect(result).toBeNull();
  });

  it("returns null when head SHA is missing", () => {
    const payload = makePRPayload();
    payload.pull_request.head.sha = "";
    const result = parsePullRequestEvent(payload);
    expect(result).toBeNull();
  });
});

// ─── Webhook Endpoint ────────────────────────────────────────────────

describe("webhook endpoint", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.GITEA_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.GITEA_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.GITEA_WEBHOOK_SECRET;
    }
  });

  // Import routes lazily so env vars take effect
  async function getApp() {
    const { Hono } = await import("hono");
    const { webhookRoutes } = await import("../routes.js");
    const app = new Hono();
    app.route("/webhooks", webhookRoutes);
    return app;
  }

  it("returns 200 for unsupported event types", async () => {
    delete process.env.GITEA_WEBHOOK_SECRET;
    const app = await getApp();
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "star",
      },
      body: JSON.stringify({ action: "created" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ignored");
  });

  it("returns 401 when secret is set but signature is missing", async () => {
    process.env.GITEA_WEBHOOK_SECRET = "test-secret-123";
    const app = await getApp();
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
      },
      body: JSON.stringify(makePushPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is invalid", async () => {
    process.env.GITEA_WEBHOOK_SECRET = "test-secret-123";
    const app = await getApp();
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
        "X-Gitea-Signature": "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad",
      },
      body: JSON.stringify(makePushPayload()),
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid HMAC signature", async () => {
    const secret = "test-secret-123";
    process.env.GITEA_WEBHOOK_SECRET = secret;
    const app = await getApp();
    const payload = JSON.stringify(makePushPayload());
    const sig = createHmac("sha256", secret).update(payload).digest("hex");

    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
        "X-Gitea-Signature": sig,
      },
      body: payload,
    });
    // Should be 202 (queued) or 200 (already running) — not 401
    expect(res.status).not.toBe(401);
    expect([200, 202]).toContain(res.status);
  });

  it("returns 400 for invalid JSON", async () => {
    delete process.env.GITEA_WEBHOOK_SECRET;
    const app = await getApp();
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

// ─── PR Comment Formatting ───────────────────────────────────────────

describe("formatPRComment", () => {
  it("formats a passing result", () => {
    const result: CIResult = {
      success: true,
      testOutput: "391 tests passed",
      tscOutput: "",
      testPassed: true,
      tscPassed: true,
      durationMs: 12345,
    };
    const comment = formatPRComment(result);
    expect(comment).toContain("✅");
    expect(comment).toContain("All checks passed");
    expect(comment).toContain("12.3s");
    expect(comment).toContain("Tests passed");
    expect(comment).toContain("TypeScript: no errors");
  });

  it("formats a failing result with test output", () => {
    const result: CIResult = {
      success: false,
      testOutput: "FAIL src/test.ts\nExpected 1, got 2",
      tscOutput: "",
      testPassed: false,
      tscPassed: true,
      durationMs: 5000,
    };
    const comment = formatPRComment(result);
    expect(comment).toContain("❌");
    expect(comment).toContain("Checks failed");
    expect(comment).toContain("Tests failed");
    expect(comment).toContain("Test output");
    expect(comment).toContain("Expected 1, got 2");
  });

  it("formats a result with tsc errors", () => {
    const result: CIResult = {
      success: false,
      testOutput: "",
      tscOutput: "src/foo.ts(10): error TS2345",
      testPassed: true,
      tscPassed: false,
      durationMs: 3000,
    };
    const comment = formatPRComment(result);
    expect(comment).toContain("TypeScript: errors found");
    expect(comment).toContain("TypeScript errors");
    expect(comment).toContain("TS2345");
  });

  it("includes error message when present", () => {
    const result: CIResult = {
      success: false,
      testOutput: "",
      tscOutput: "",
      testPassed: false,
      tscPassed: false,
      durationMs: 100,
      error: "Clone failed",
    };
    const comment = formatPRComment(result);
    expect(comment).toContain("Clone failed");
  });
});

// ─── Commit Status Posting (mock fetch) ──────────────────────────────

describe("postCommitStatus", () => {
  it("calls Gitea API with correct parameters", async () => {
    const originalFetch = globalThis.fetch;
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      calls.push({ url: url.toString(), opts });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as any;

    try {
      const { postCommitStatus } = await import("../ci-runner.js");
      await postCommitStatus("hdresearch", "vers-agent-services", "abc123", "success", "All tests passed");

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const statusCall = calls.find((c) => c.url.includes("/statuses/"));
      expect(statusCall).toBeDefined();
      expect(statusCall.url).toContain("/repos/hdresearch/vers-agent-services/statuses/abc123");
      const body = JSON.parse(statusCall.opts.body);
      expect(body.state).toBe("success");
      expect(body.context).toBe("ci/vers-fleet");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── PR Comment Posting (mock fetch) ─────────────────────────────────

describe("postPRComment", () => {
  it("calls Gitea issues API", async () => {
    const originalFetch = globalThis.fetch;
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      calls.push({ url: url.toString(), opts });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as any;

    try {
      const { postPRComment } = await import("../ci-runner.js");
      await postPRComment("hdresearch", "vers-agent-services", 42, "## CI Results\n\n✅ passed");

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const commentCall = calls.find((c) => c.url.includes("/issues/42/comments"));
      expect(commentCall).toBeDefined();
      const body = JSON.parse(commentCall.opts.body);
      expect(body.body).toContain("CI Results");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
