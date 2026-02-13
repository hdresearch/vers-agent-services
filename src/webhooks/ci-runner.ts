import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GITEA_BASE =
  process.env.GITEA_URL ||
  "https://b6f1cc18-713a-4e3f-bb8d-a0064646f963.vm.vers.sh:3000";
const GITEA_TOKEN = process.env.GITEA_TOKEN || "9fe8f6e54a36e255ad56da2aac63616e3fc3a3bd";
const CI_TIMEOUT_MS = parseInt(process.env.CI_TIMEOUT_MS || "300000", 10); // 5 min

export interface CIRequest {
  owner: string;
  repo: string;
  sha: string;
  branch: string;
  prNumber?: number;
  cloneUrl: string;
}

export interface CIResult {
  success: boolean;
  testOutput: string;
  tscOutput: string;
  testPassed: boolean;
  tscPassed: boolean;
  durationMs: number;
  error?: string;
}

/** Run a shell command in a given cwd, with timeout. */
function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      const code = err ? (err as any).code ?? 1 : 0;
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
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
  const url = `${GITEA_BASE}/api/v1/repos/${owner}/${repo}/statuses/${sha}`;
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
  const url = `${GITEA_BASE}/api/v1/repos/${owner}/${repo}/issues/${prNumber}/comments`;
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

/** Run CI for a given request. Returns the result. */
export async function runCI(req: CIRequest): Promise<CIResult> {
  const start = Date.now();

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
      ["clone", "--depth", "1", "--branch", req.branch, req.cloneUrl, tmpDir + "/repo"],
      tmpDir,
      60_000,
    );
    if (cloneResult.code !== 0) {
      const result: CIResult = {
        success: false,
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

    // npm install
    const installResult = await exec("npm", ["install"], repoDir, 120_000);
    if (installResult.code !== 0) {
      const result: CIResult = {
        success: false,
        testOutput: "",
        tscOutput: "",
        testPassed: false,
        tscPassed: false,
        durationMs: Date.now() - start,
        error: `npm install failed: ${installResult.stderr.slice(-500)}`,
      };
      await postCommitStatus(req.owner, req.repo, req.sha, "error", "npm install failed");
      await postFeedEvent("ci_completed", `CI failed: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} — install failed`);
      return result;
    }

    // npm test
    const testResult = await exec("npm", ["test"], repoDir, CI_TIMEOUT_MS);
    const testPassed = testResult.code === 0;
    const testOutput = (testResult.stdout + "\n" + testResult.stderr).trim();

    // tsc --noEmit
    const tscResult = await exec("npx", ["tsc", "--noEmit"], repoDir, CI_TIMEOUT_MS);
    const tscPassed = tscResult.code === 0;
    const tscOutput = (tscResult.stdout + "\n" + tscResult.stderr).trim();

    const success = testPassed && tscPassed;
    const durationMs = Date.now() - start;
    const result: CIResult = { success, testOutput, tscOutput, testPassed, tscPassed, durationMs };

    // Post commit status
    const state = success ? "success" : "failure";
    const desc = success
      ? `All checks passed (${(durationMs / 1000).toFixed(1)}s)`
      : `Checks failed: ${!testPassed ? "tests" : ""}${!testPassed && !tscPassed ? " + " : ""}${!tscPassed ? "tsc" : ""}`;
    await postCommitStatus(req.owner, req.repo, req.sha, state, desc);

    // Post PR comment if applicable
    if (req.prNumber) {
      await postPRComment(req.owner, req.repo, req.prNumber, formatPRComment(result));
    }

    // Feed event
    await postFeedEvent(
      "ci_completed",
      `CI ${success ? "passed" : "failed"}: ${req.owner}/${req.repo}@${req.sha.slice(0, 8)} (${(durationMs / 1000).toFixed(1)}s)`,
      JSON.stringify({ success, testPassed, tscPassed, durationMs }),
    );

    return result;
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const result: CIResult = {
      success: false,
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
