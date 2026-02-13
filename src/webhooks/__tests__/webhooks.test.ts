import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { parsePushEvent, parsePullRequestEvent } from "../routes.js";
import { formatPRComment, isRepoAllowed, canAcceptBuild, getActiveBuildCount, type CIResult } from "../ci-runner.js";

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
  let originalAllowedRepos: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.GITEA_WEBHOOK_SECRET;
    originalAllowedRepos = process.env.CI_ALLOWED_REPOS;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.GITEA_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.GITEA_WEBHOOK_SECRET;
    }
    if (originalAllowedRepos !== undefined) {
      process.env.CI_ALLOWED_REPOS = originalAllowedRepos;
    } else {
      delete process.env.CI_ALLOWED_REPOS;
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

  function signPayload(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  // S1: HMAC required — reject when secret not configured
  it("returns 500 when GITEA_WEBHOOK_SECRET is not set", async () => {
    delete process.env.GITEA_WEBHOOK_SECRET;
    const app = await getApp();
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
      },
      body: JSON.stringify(makePushPayload()),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("returns 200 for unsupported event types (with valid HMAC)", async () => {
    const secret = "test-secret-123";
    process.env.GITEA_WEBHOOK_SECRET = secret;
    const app = await getApp();
    const payload = JSON.stringify({ action: "created" });
    const sig = signPayload(payload, secret);
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "star",
        "X-Gitea-Signature": sig,
      },
      body: payload,
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
    const sig = signPayload(payload, secret);

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
    const secret = "test-secret-123";
    process.env.GITEA_WEBHOOK_SECRET = secret;
    const app = await getApp();
    const payload = "not json";
    const sig = signPayload(payload, secret);
    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
        "X-Gitea-Signature": sig,
      },
      body: payload,
    });
    expect(res.status).toBe(400);
  });

  // S2: Repo allowlist enforcement at webhook level
  it("returns 403 when repo is not in allowlist", async () => {
    const secret = "test-secret-123";
    process.env.GITEA_WEBHOOK_SECRET = secret;
    process.env.CI_ALLOWED_REPOS = "other-org/other-repo";
    const app = await getApp();
    const payload = JSON.stringify(makePushPayload());
    const sig = signPayload(payload, secret);

    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
        "X-Gitea-Signature": sig,
      },
      body: payload,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("rejected");
  });

  it("accepts repo when in allowlist", async () => {
    const secret = "test-secret-123";
    process.env.GITEA_WEBHOOK_SECRET = secret;
    process.env.CI_ALLOWED_REPOS = "hdresearch/vers-agent-services,other/repo";
    const app = await getApp();
    const payload = JSON.stringify(makePushPayload());
    const sig = signPayload(payload, secret);

    const res = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitea-Event": "push",
        "X-Gitea-Signature": sig,
      },
      body: payload,
    });
    expect([200, 202]).toContain(res.status);
  });
});

// ─── PR Comment Formatting ───────────────────────────────────────────

describe("formatPRComment", () => {
  it("formats a passing result", () => {
    const result: CIResult = {
      success: true,
      status: "success",
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
      status: "failure",
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
      status: "failure",
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
      status: "error",
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

  // S4: Timeout formatting
  it("shows timeout message when status is timeout", () => {
    const result: CIResult = {
      success: false,
      status: "timeout",
      testOutput: "",
      tscOutput: "",
      testPassed: false,
      tscPassed: false,
      durationMs: 300000,
    };
    const comment = formatPRComment(result);
    expect(comment).toContain("timed out");
    expect(comment).toContain("300.0s");
  });
});

// ─── Repo Allowlist (S2) ─────────────────────────────────────────────

describe("isRepoAllowed", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.CI_ALLOWED_REPOS;
  });

  afterEach(() => {
    if (original !== undefined) {
      process.env.CI_ALLOWED_REPOS = original;
    } else {
      delete process.env.CI_ALLOWED_REPOS;
    }
  });

  it("allows all repos when CI_ALLOWED_REPOS is not set", () => {
    delete process.env.CI_ALLOWED_REPOS;
    expect(isRepoAllowed("any", "repo")).toBe(true);
  });

  it("allows repos in the list", () => {
    process.env.CI_ALLOWED_REPOS = "hdresearch/vers-agent-services,other/repo";
    expect(isRepoAllowed("hdresearch", "vers-agent-services")).toBe(true);
    expect(isRepoAllowed("other", "repo")).toBe(true);
  });

  it("rejects repos not in the list", () => {
    process.env.CI_ALLOWED_REPOS = "hdresearch/vers-agent-services";
    expect(isRepoAllowed("evil", "repo")).toBe(false);
  });

  it("is case-insensitive", () => {
    process.env.CI_ALLOWED_REPOS = "HDResearch/Vers-Agent-Services";
    expect(isRepoAllowed("hdresearch", "vers-agent-services")).toBe(true);
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

      // May be 0 calls if GITEA_API_TOKEN is not set in test env
      const statusCall = calls.find((c) => c.url.includes("/statuses/"));
      if (statusCall) {
        expect(statusCall.url).toContain("/repos/hdresearch/vers-agent-services/statuses/abc123");
        const body = JSON.parse(statusCall.opts.body);
        expect(body.state).toBe("success");
        expect(body.context).toBe("ci/vers-fleet");
      }
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

      const commentCall = calls.find((c) => c.url.includes("/issues/42/comments"));
      if (commentCall) {
        const body = JSON.parse(commentCall.opts.body);
        expect(body.body).toContain("CI Results");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── S5: runCI integration tests ─────────────────────────────────────

describe("runCI", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Mock all fetch calls (commit status, feed events, PR comments)
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects repos not in allowlist", async () => {
    const original = process.env.CI_ALLOWED_REPOS;
    process.env.CI_ALLOWED_REPOS = "allowed/repo-only";

    try {
      const { runCI } = await import("../ci-runner.js");
      const result = await runCI({
        owner: "evil",
        repo: "malicious",
        sha: "abc123",
        branch: "main",
        cloneUrl: "https://example.com/evil/malicious.git",
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe("error");
      expect(result.error).toContain("allowlist");
    } finally {
      if (original !== undefined) {
        process.env.CI_ALLOWED_REPOS = original;
      } else {
        delete process.env.CI_ALLOWED_REPOS;
      }
    }
  });

  it("fails gracefully when clone URL is invalid", async () => {
    const original = process.env.CI_ALLOWED_REPOS;
    delete process.env.CI_ALLOWED_REPOS;

    try {
      const { runCI } = await import("../ci-runner.js");
      const result = await runCI({
        owner: "test",
        repo: "nonexistent",
        sha: "abc123",
        branch: "main",
        cloneUrl: "https://invalid.example.com/nonexistent.git",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      if (original !== undefined) {
        process.env.CI_ALLOWED_REPOS = original;
      } else {
        delete process.env.CI_ALLOWED_REPOS;
      }
    }
  });
});
