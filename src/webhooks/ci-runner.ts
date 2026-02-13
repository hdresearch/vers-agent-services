import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GITEA_BASE =
  process.env.GITEA_URL ||
  "https://b6f1cc18-713a-4e3f-bb8d-a0064646f963.vm.vers.sh:3000";

// B1: Token must come from environment — never hardcoded
const GITEA_TOKEN = process.env.GITEA_API_TOKEN || "";
const CI_TIMEOUT_MS = parseInt(process.env.CI_TIMEOUT_MS || "300000", 10); // 5 min

// S3: Concurrency semaphore — max concurrent builds
const MAX_CONCURRENT_BUILDS = parseInt(process.env.CI_MAX_CONCURRENT || "3", 10);
let activeBuildCount = 0;

export function getActiveBuildCount(): number {
  return activeBuildCount;
}

export interface CIRequest {
  owner: string;
  repo: string;
  sha: string;
  branch: string;
  prNumber?: number;
  cloneUrl: string;
}

export type CIResultStatus = "success" | "failure" | "timeout" | "error";

export interface CIResult {
  success: boolean;
  status: CIResultStatus; // S4: distinguish timeout from failure
  testOutput: string;
  tscOutput: string;
  testPassed: boolean;
  tscPassed: boolean;
  durationMs: number;
  error?: string;
}

/** Run a command in a given cwd, with timeout. No shell interpretation (B2). */
function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // B2: No shell: true — execFile with array args, no shell interpretation
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let timedOut = false;
      let code = 0;
      if (err) {
        // S4: Detect timeout — node sets err.killed and err.signal when timeout fires
        if ((err as any).killed || (err as any).signal === "SIGTERM") {
          timedOut = true;
        }
        code = typeof (err as any).code === "number" ? (err as any).code : 1;
      }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Post a commit status to Gitea */
export async function postCommitStatus(
  owner: string,
  repo: string,
  sha: string,
  state: "pending" | "success" | "failure" | "error",
  description: string,
  targetUrl?: string,
): Promise<void> {
  if (!GITEA_TOKEN) {
    console.error("GITEA_API_TOKEN not set — skipping commit status post");
    return;
  }
  const url = `${GITEA_BASE}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(sha)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${GITEA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state,
      target_url: targetUrl || "",
      description: description.slice(0, 140),
      context: "ci/vers-fleet",
    }),
  });
  if (!resp.ok) {
    console.error(`Failed to post commit status: ${resp.status} ${await resp.text()}`);
  }
}

/** Post a comment on a Gitea PR/issue */
export async function postPRComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  if (!GITEA_TOKEN) {
    console.error("GITEA_API_TOKEN not set — skipping PR comment");
    return;
  }
  const url = `${GITEA_BASE}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${GITEA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!resp.ok) {
    console.error(`Failed to post PR comment: ${resp.status} ${await resp.text()}`);
  }
}

/** Post event to the local feed */
async function postFeedEvent(
  type: string,
  summary: string,
  detail?: string,
): Promise<void> {
  const port = process.env.PORT || "3000";
  const token = process.env.VERS_AUTH_TOKEN || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    await fetch(`http://localhost:${port}/feed/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: "ci-runner",
        type: type === "ci_started" ? "task_started" : type === "ci_completed" ? "task_completed" : "custom",
        summary,
        detail,
      }),
    });
  } catch (err) {
    console.error("Failed to post feed event:", err);
  }
}

/** Format a CI result into a PR comment body */
export function formatPRComment(result: CIResult): string {
  const status = result.success ? "✅" : "❌";
  const testStatus = result.testPassed ? "✅ Tests passed" : "❌ Tests failed";
  const tscStatus = result.tscPassed ? "✅ TypeScript: no errors" : "❌ TypeScript: errors found";

  let body = `## CI Results\n\n${status} **${result.success ? "All checks passed" : "Checks failed"}** (${(result.durationMs / 1000).toFixed(1)}s)\n\n`;
  body += `- ${testStatus}\n`;
  body += `- ${tscStatus}\n`;

  if (result.status === "timeout") {
    body += `\n⏱️ **Build timed out** after ${(result.durationMs / 1000).toFixed(1)}s\n`;
  }

  if (!result.testPassed && result.testOutput) {
    const trimmed = result.testOutput.slice(-2000);
    body += `\n<details><summary>Test output</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n</details>\n`;
  }
  if (!result.tscPassed && result.tscOutput) {
    const trimmed = result.tscOutput.slice(-2000);
    body += `\n<details><summary>TypeScript errors</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n</details>\n`;
  }
  if (result.error) {
    body += `\n**Error:** ${result.error}\n`;
  }
  return body;
}

// S2: Repo allowlist
export function isRepoAllowed(owner: string, repo: string): boolean {
  const allowlist = process.env.CI_ALLOWED_REPOS;
  if (!allowlist) return true; // If not configured, allow all (backward compat)
  const allowed = allowlist.split(",").map((s) => s.trim().toLowerCase());
  return allowed.includes(`${owner}/${repo}`.toLowerCase());
}

// S3: Semaphore check
export function canAcceptBuild(): boolean {
  return activeBuildCount < MAX_CONCURRENT_BUILDS;
}

/** Run CI for a given request. Returns the result. */
export async function runCI(req: CIRequest): Promise<CIResult> {
  const start = Date.now();

  // S2: Check repo allowlist
  if (!isRepoAllowed(req.owner, req.repo)) {
    return {
      success: false,
      status: "error",
      testOutput: "",
      tscOutput: "",
      testPassed: false,
      tscPassed: false,
      durationMs: Date.now() - start,
      error: `Repo ${req.owner}/${req.repo} is not in CI_ALLOWED_REPOS allowlist`,
    };
  }

  // S3: Concurrency limit
  activeBuildCount++;

  try {
    return await _runCIInner(req, start);
  } finally {
    activeBuildCount--;
  }
}

async function _runCIInner(req: CIRequest, start: number): Promise<CIResult> {
  await postFeedEvent(
    "ci_started",
    `CI started: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} (${req.branch})`,
    JSON.stringify({ owner: req.owner, repo: req.repo, sha: req.sha, branch: req.branch, prNumber: req.prNumber }),
  );

  // Set pending status
  await postCommitStatus(req.owner, req.repo, req.sha, "pending", "CI running...");

  let tmpDir: string | undefined;
  try {
    // Clone into temp dir
    tmpDir = await mkdtemp(join(tmpdir(), "ci-"));
    const cloneResult = await exec(
      "git",
      ["clone", "--depth", "1", "--branch", req.branch, req.cloneUrl, join(tmpDir, "repo")],
      tmpDir,
      60_000,
    );
    if (cloneResult.code !== 0) {
      const result: CIResult = {
        success: false,
        status: cloneResult.timedOut ? "timeout" : "error",
        testOutput: "",
        tscOutput: "",
        testPassed: false,
        tscPassed: false,
        durationMs: Date.now() - start,
        error: `git clone failed: ${cloneResult.stderr.slice(-500)}`,
      };
      await postCommitStatus(req.owner, req.repo, req.sha, "error", "Clone failed");
      await postFeedEvent("ci_completed", `CI failed: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} — clone failed`);
      return result;
    }

    const repoDir = join(tmpDir, "repo");

    // B3 + B4: Use bun install --ignore-scripts to prevent arbitrary code execution
    const installResult = await exec("bun", ["install", "--ignore-scripts"], repoDir, 120_000);
    if (installResult.code !== 0) {
      const result: CIResult = {
        success: false,
        status: installResult.timedOut ? "timeout" : "error",
        testOutput: "",
        tscOutput: "",
        testPassed: false,
        tscPassed: false,
        durationMs: Date.now() - start,
        error: `bun install failed: ${installResult.stderr.slice(-500)}`,
      };
      await postCommitStatus(req.owner, req.repo, req.sha, "error", "bun install failed");
      await postFeedEvent("ci_completed", `CI failed: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} — install failed`);
      return result;
    }

    // B4: Use bun test
    const testResult = await exec("bun", ["test"], repoDir, CI_TIMEOUT_MS);
    const testPassed = testResult.code === 0;
    const testTimedOut = testResult.timedOut;
    const testOutput = (testResult.stdout + "\n" + testResult.stderr).trim();

    // B4: Use bun for tsc — via bunx or direct tsc path
    const tscResult = await exec("bunx", ["tsc", "--noEmit"], repoDir, CI_TIMEOUT_MS);
    const tscPassed = tscResult.code === 0;
    const tscTimedOut = tscResult.timedOut;
    const tscOutput = (tscResult.stdout + "\n" + tscResult.stderr).trim();

    const success = testPassed && tscPassed;
    const timedOut = testTimedOut || tscTimedOut;
    const durationMs = Date.now() - start;

    // S4: Set status correctly
    let status: CIResultStatus;
    if (timedOut) status = "timeout";
    else if (success) status = "success";
    else status = "failure";

    const result: CIResult = { success, status, testOutput, tscOutput, testPassed, tscPassed, durationMs };

    // Post commit status
    const commitState = timedOut ? "error" : success ? "success" : "failure";
    const desc = timedOut
      ? `Build timed out after ${(durationMs / 1000).toFixed(1)}s`
      : success
        ? `All checks passed (${(durationMs / 1000).toFixed(1)}s)`
        : `Checks failed: ${!testPassed ? "tests" : ""}${!testPassed && !tscPassed ? " + " : ""}${!tscPassed ? "tsc" : ""}`;
    await postCommitStatus(req.owner, req.repo, req.sha, commitState, desc);

    // Post PR comment if applicable
    if (req.prNumber) {
      await postPRComment(req.owner, req.repo, req.prNumber, formatPRComment(result));
    }

    // Feed event
    const feedSummary = timedOut
      ? `CI timeout: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} (${(durationMs / 1000).toFixed(1)}s)`
      : `CI ${success ? "passed" : "failed"}: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} (${(durationMs / 1000).toFixed(1)}s)`;
    await postFeedEvent(
      "ci_completed",
      feedSummary,
      JSON.stringify({ success, status, testPassed, tscPassed, durationMs }),
    );

    return result;
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const result: CIResult = {
      success: false,
      status: "error",
      testOutput: "",
      tscOutput: "",
      testPassed: false,
      tscPassed: false,
      durationMs,
      error: err.message || String(err),
    };
    await postCommitStatus(req.owner, req.repo, req.sha, "error", `CI error: ${err.message?.slice(0, 100)}`);
    await postFeedEvent("ci_completed", `CI error: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} — ${err.message}`);
    return result;
  } finally {
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
