import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { runCI, isRepoAllowed, canAcceptBuild, type CIRequest } from "./ci-runner.js";
import { emit } from "../events/emit.js";

export const webhookRoutes = new Hono();

const GITEA_BASE =
  process.env.GITEA_URL ||
  "https://b6f1cc18-713a-4e3f-bb8d-a0064646f963.vm.vers.sh:3000";

/** Validate Gitea webhook HMAC signature */
function validateSignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Parse a push event payload */
export function parsePushEvent(body: any): CIRequest | null {
  const ref: string = body.ref || "";
  const branch = ref.replace("refs/heads/", "");
  if (!branch) return null;

  const commits = body.commits || [];
  const sha: string = body.after || (commits.length > 0 ? commits[commits.length - 1]?.id : "");
  if (!sha || sha === "0000000000000000000000000000000000000000") return null;

  const repo = body.repository;
  if (!repo) return null;

  const owner: string = repo.owner?.login || repo.owner?.username || "";
  const repoName: string = repo.name || "";
  if (!owner || !repoName) return null;

  const cloneUrl: string = repo.clone_url || `${GITEA_BASE}/${owner}/${repoName}.git`;

  return { owner, repo: repoName, sha, branch, cloneUrl };
}

/** Parse a pull_request event payload */
export function parsePullRequestEvent(body: any): CIRequest | null {
  const action: string = body.action || "";
  if (!["opened", "synchronize", "reopened"].includes(action)) return null;

  const pr = body.pull_request;
  if (!pr) return null;

  const sha: string = pr.head?.sha || "";
  const branch: string = pr.head?.ref || "";
  if (!sha || !branch) return null;

  const repo = body.repository;
  if (!repo) return null;

  const owner: string = repo.owner?.login || repo.owner?.username || "";
  const repoName: string = repo.name || "";
  if (!owner || !repoName) return null;

  const cloneUrl: string = repo.clone_url || `${GITEA_BASE}/${owner}/${repoName}.git`;
  const prNumber: number = pr.number;

  return { owner, repo: repoName, sha, branch, prNumber, cloneUrl };
}

// Active CI runs — simple in-memory tracking
const activeRuns = new Map<string, { startedAt: number; owner: string; repo: string; sha: string }>();

webhookRoutes.post("/gitea", async (c) => {
  // S1: HMAC validation is required — reject if secret not configured
  const secret = process.env.GITEA_WEBHOOK_SECRET;
  if (!secret) {
    console.error("GITEA_WEBHOOK_SECRET is not set — rejecting all webhooks");
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  const rawBody = await c.req.text();

  // Validate webhook signature (always required)
  const signature = c.req.header("X-Gitea-Signature");
  if (!validateSignature(rawBody, signature, secret)) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const event = c.req.header("X-Gitea-Event");

  let ciReq: CIRequest | null = null;

  if (event === "push") {
    ciReq = parsePushEvent(body);
  } else if (event === "pull_request") {
    ciReq = parsePullRequestEvent(body);
  } else {
    return c.json({ status: "ignored", reason: `Unsupported event type: ${event}` }, 200);
  }

  if (!ciReq) {
    return c.json({ status: "ignored", reason: "Could not extract CI request from payload" }, 200);
  }

  // S2: Check repo allowlist
  if (!isRepoAllowed(ciReq.owner, ciReq.repo)) {
    return c.json({ status: "rejected", reason: `Repo ${ciReq.owner}/${ciReq.repo} is not in the CI allowlist` }, 403);
  }

  // S3: Check concurrency limit
  if (!canAcceptBuild()) {
    return c.json({ status: "rejected", reason: "Too many concurrent builds — try again later" }, 429);
  }

  // Deduplicate: don't run the same SHA twice concurrently
  const runKey = `${ciReq.owner}/${ciReq.repo}/${ciReq.sha}`;
  if (activeRuns.has(runKey)) {
    return c.json({ status: "already_running", sha: ciReq.sha }, 200);
  }

  activeRuns.set(runKey, { startedAt: Date.now(), owner: ciReq.owner, repo: ciReq.repo, sha: ciReq.sha });

  // Emit webhook event to durable log
  const eventType = event === "push" ? "webhook.gitea.push" : "webhook.gitea.pr";
  emit('webhook', eventType, { owner: ciReq.owner, repo: ciReq.repo, sha: ciReq.sha, branch: ciReq.branch, prNumber: ciReq.prNumber });

  // Fire and forget — webhook should respond quickly
  const req = ciReq;
  runCI(req)
    .then((result) => {
      console.log(`CI ${result.status}: ${runKey} (${(result.durationMs / 1000).toFixed(1)}s)`);
    })
    .catch((err) => {
      console.error(`CI error for ${runKey}:`, err);
    })
    .finally(() => {
      activeRuns.delete(runKey);
    });

  return c.json({
    status: "queued",
    owner: ciReq.owner,
    repo: ciReq.repo,
    sha: ciReq.sha,
    branch: ciReq.branch,
    prNumber: ciReq.prNumber,
  }, 202);
});

// GET /status — list active CI runs
webhookRoutes.get("/status", (c) => {
  const runs = Array.from(activeRuns.entries()).map(([key, val]) => ({
    key,
    ...val,
    runningFor: `${((Date.now() - val.startedAt) / 1000).toFixed(0)}s`,
  }));
  return c.json({ active: runs.length, runs });
});
