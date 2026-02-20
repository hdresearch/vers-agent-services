import { Hono } from "hono";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { ulid } from "ulid";
import { BoardStore } from "../board/store.js";
import { feedStore } from "../feed/routes.js";
import type { Task } from "../board/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImplementJob {
  id: string;
  taskId: string;
  vmId: string;
  status: "starting" | "running" | "done" | "failed";
  startedAt: string;
  completedAt?: string;
  prUrl?: string;
  error?: string;
}

interface ImplementRequest {
  goldenCommitId: string;
  repo: string;
  baseBranch?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const jobs = new Map<string, ImplementJob>();
const jobOutputs = new Map<string, string>(); // jobId -> accumulated output
const boardStore = new BoardStore();

// ---------------------------------------------------------------------------
// Vers API helpers
// ---------------------------------------------------------------------------

const VERS_API = "https://api.vers.sh/api/v1";

function versHeaders(): Record<string, string> {
  const key = process.env.VERS_API_KEY;
  if (!key) throw new Error("VERS_API_KEY is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function createVmFromCommit(commitId: string): Promise<string> {
  const res = await fetch(`${VERS_API}/vm/from_commit`, {
    method: "POST",
    headers: versHeaders(),
    body: JSON.stringify({ commit_id: commitId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vers VM creation failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { id?: string; vm_id?: string };
  const vmId = data.id || data.vm_id;
  if (!vmId) throw new Error("Vers API did not return a VM id");
  return vmId;
}

async function getSSHKey(vmId: string): Promise<{ sshPort: number; sshPrivateKey: string }> {
  const res = await fetch(`${VERS_API}/vm/${vmId}/ssh_key`, {
    headers: versHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vers SSH key fetch failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { ssh_port: number; ssh_private_key: string };
  return { sshPort: data.ssh_port, sshPrivateKey: data.ssh_private_key };
}

async function deleteVm(vmId: string): Promise<void> {
  try {
    await fetch(`${VERS_API}/vm/${vmId}`, {
      method: "DELETE",
      headers: versHeaders(),
    });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// SSH helper
// ---------------------------------------------------------------------------

function sshExec(
  vmId: string,
  keyFile: string,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", keyFile,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=10",
      "-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
      `root@${vmId}.vm.vers.sh`,
      command,
    ];

    const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Spawn a long-running SSH that streams stdout (for tailing RPC output). */
function sshStream(
  vmId: string,
  keyFile: string,
  command: string,
  onData: (chunk: string) => void,
): { kill: () => void } {
  const args = [
    "-i", keyFile,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=10",
    "-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
    `root@${vmId}.vm.vers.sh`,
    command,
  ];

  const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (d: Buffer) => onData(d.toString()));
  proc.stderr.on("data", (d: Buffer) => onData(d.toString()));

  return {
    kill: () => {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildPrompt(task: Task, repo: string, baseBranch: string): string {
  const notesSection = task.notes.length > 0
    ? task.notes.map((n) => `- **${n.author}** (${n.type}): ${n.content}`).join("\n")
    : "_No notes yet._";

  const artifactsSection = task.artifacts.length > 0
    ? task.artifacts.map((a) => `- ${a.label} → ${a.url}`).join("\n")
    : "_No artifacts._";

  const slug = slugify(task.title);

  return `You are an implementation agent. Your job is to implement the changes described below and create a PR.

## Task: ${task.title}
${task.description || "No description provided."}

## Findings from investigation:
${notesSection}

## Artifacts:
${artifactsSection}

## Instructions:
1. Clone the repository: git clone ${repo} /root/workspace/chelsea
2. cd /root/workspace/chelsea
3. Create a NEW branch: git checkout -b fix/${slug}
4. Implement the changes described in the findings above
5. Commit your changes on your new branch
6. Push your new branch: git push origin fix/${slug}
7. Create a NEW PR: gh pr create --base ${baseBranch} --title "${task.title}" --body "Automated implementation for task ${task.id}\\n\\nBased on investigation findings from the board."
8. Report back the PR URL

## CRITICAL SAFETY RULES — READ BEFORE DOING ANYTHING:
- You may ONLY create a NEW branch and a NEW pull request.
- Do NOT modify, close, merge, edit, or comment on any existing PRs.
- Do NOT push to any existing branch (main, next, or any other branch that already exists).
- Do NOT use \`git push --force\` or \`git push -f\` under any circumstances.
- Do NOT use \`gh pr close\`, \`gh pr merge\`, \`gh pr edit\`, or \`gh pr review\` on any PR.
- Do NOT delete any remote branches.
- If your branch name already exists on the remote, append a short random suffix (e.g. fix/${slug}-a1b2) instead of force-pushing.
- Your ONLY git write operations should be: create branch, commit, push new branch, create new PR. Nothing else.

## Progress reporting:
You have access to the coordination dashboard. Use these tools as you work:
- Use feed_publish (type="custom", agent="implement-agent") to report major milestones (e.g. "cloned repo", "branch created", "implementation complete", "PR created")
- Use board_add_note (taskId="${task.id}", type="update") to post progress updates to the task
- When done, use board_add_note with the PR URL so reviewers can find it

The task ID is: ${task.id}`;
}

// ---------------------------------------------------------------------------
// Implementation runner (async background job)
// ---------------------------------------------------------------------------

async function runImplementation(job: ImplementJob, task: Task, request: ImplementRequest): Promise<void> {
  const baseBranch = request.baseBranch || "next";
  let keyFile = "";
  let tailer: { kill: () => void } | null = null;

  try {
    // 1. Publish start event
    feedStore.publish({
      agent: "implement",
      type: "task_started",
      summary: `Implementation started for task: ${task.title}`,
      metadata: { taskId: task.id, jobId: job.id },
    });

    // 2. Create VM from golden commit
    job.status = "starting";
    const vmId = await createVmFromCommit(request.goldenCommitId);
    job.vmId = vmId;

    // 3. Get SSH credentials
    const { sshPrivateKey } = await getSSHKey(vmId);

    // Write key to temp file
    const keyDir = "/tmp/implement-keys";
    if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });
    keyFile = `${keyDir}/${job.id}.pem`;
    writeFileSync(keyFile, sshPrivateKey, { mode: 0o600 });

    // 4. Wait for VM to be SSH-ready (retry a few times)
    let sshReady = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const check = await sshExec(vmId, keyFile, "echo ready");
        if (check.stdout.trim() === "ready") {
          sshReady = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!sshReady) {
      throw new Error("VM did not become SSH-ready within 60 seconds");
    }

    // 4b. Install safety wrappers that mechanically block destructive operations.
    //     These replace the real gh/git with wrapper scripts that filter commands.
    //     The agent CAN'T bypass these — they're the actual binaries on PATH.
    const safetyScript = [
      "set -e",
      "",
      "# --- gh wrapper: only allow 'gh pr create' and read-only commands ---",
      "REAL_GH=$(which gh)",
      "cat > /usr/local/bin/gh << 'GHWRAP'",
      "#!/bin/bash",
      'BLOCKED_PR="close merge edit review comment delete"',
      'BLOCKED_TOP="repo issue gist"',
      'if [ "$1" = "pr" ]; then',
      '  for b in $BLOCKED_PR; do',
      '    if [ "$2" = "$b" ]; then',
      '      echo "BLOCKED: gh pr $2 is not allowed. This agent may only create new PRs." >&2',
      "      exit 1",
      "    fi",
      "  done",
      "fi",
      'for b in $BLOCKED_TOP; do',
      '  if [ "$1" = "$b" ] && [ "$2" != "view" ] && [ "$2" != "list" ]; then',
      '    echo "BLOCKED: gh $1 $2 is not allowed." >&2',
      "    exit 1",
      "  fi",
      "done",
      'exec "$REAL_GH_BIN" "$@"',
      "GHWRAP",
      'sed -i "s|\\$REAL_GH_BIN|$REAL_GH|" /usr/local/bin/gh',
      "chmod +x /usr/local/bin/gh",
      "",
      "# --- git wrapper: block force-push, push to protected branches, delete ---",
      "REAL_GIT=$(which git)",
      'mv "$REAL_GIT" "${REAL_GIT}.real"',
      'cat > "$REAL_GIT" << \'GITWRAP\'',
      "#!/bin/bash",
      'D=$(dirname "$0"); R="$D/git.real"',
      'if [ "$1" = "push" ]; then',
      '  for a in "$@"; do',
      '    case "$a" in',
      "      --force|--force-with-lease|-f)",
      '        echo "BLOCKED: force-push is not allowed." >&2; exit 1;;',
      "      --delete)",
      '        echo "BLOCKED: deleting remote branches is not allowed." >&2; exit 1;;',
      "      :*)",
      '        echo "BLOCKED: deleting remote refs is not allowed." >&2; exit 1;;',
      "      main|next|master|develop)",
      '        echo "BLOCKED: pushing to protected branch is not allowed." >&2; exit 1;;',
      "    esac",
      "  done",
      "fi",
      'if [ "$1" = "branch" ]; then',
      '  for a in "$@"; do',
      '    case "$a" in -D|-d|--delete)',
      '      echo "BLOCKED: deleting branches is not allowed." >&2; exit 1;;',
      "    esac",
      "  done",
      "fi",
      'exec "$R" "$@"',
      "GITWRAP",
      'chmod +x "$REAL_GIT"',
      "",
      "echo safety_installed",
    ].join("\n");

    const safetyResult = await sshExec(vmId, keyFile, safetyScript);
    if (!safetyResult.stdout.trim().endsWith("safety_installed")) {
      throw new Error(`Failed to install safety wrappers: ${safetyResult.stderr || safetyResult.stdout}`);
    }

    // 5. Start pi in RPC mode on the VM
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const infraUrl = process.env.VERS_INFRA_URL || "";
    const authToken = process.env.VERS_AUTH_TOKEN || "";
    const versApiKey = process.env.VERS_API_KEY || "";
    const agentName = `implement-${job.id.slice(0, 8)}`;

    // Build env exports — these let the spawned pi agent's agent-services
    // extension authenticate with the dashboard and report progress (feed
    // events, board notes, registry heartbeats).
    const envExports = [
      `export ANTHROPIC_API_KEY='${anthropicKey}'`,
      `export VERS_INFRA_URL='${infraUrl}'`,
      `export VERS_AUTH_TOKEN='${authToken}'`,
      `export VERS_API_KEY='${versApiKey}'`,
      `export VERS_AGENT_NAME='${agentName}'`,
      `export VERS_VM_ID='${vmId}'`,
      `export GIT_EDITOR=true`,
    ].join("; ");

    const setupScript = [
      "mkdir -p /tmp/pi-rpc",
      "rm -f /tmp/pi-rpc/in /tmp/pi-rpc/out /tmp/pi-rpc/err",
      "mkfifo /tmp/pi-rpc/in",
      "touch /tmp/pi-rpc/out /tmp/pi-rpc/err",
      `tmux new-session -d -s pi-keeper "sleep infinity > /tmp/pi-rpc/in"`,
      `tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; pi --mode rpc --no-session < /tmp/pi-rpc/in >> /tmp/pi-rpc/out 2>> /tmp/pi-rpc/err"`,
      "sleep 2",
      "tmux has-session -t pi-rpc && echo started || echo failed",
    ].join(" && ");

    const setupResult = await sshExec(vmId, keyFile, setupScript);
    if (!setupResult.stdout.trim().endsWith("started")) {
      throw new Error(`pi RPC failed to start: ${setupResult.stdout} ${setupResult.stderr}`);
    }

    // 6. Mark as running
    job.status = "running";

    feedStore.publish({
      agent: "implement",
      type: "agent_started",
      summary: `pi agent running on VM ${vmId} for task: ${task.title}`,
      metadata: { taskId: task.id, jobId: job.id, vmId },
    });

    // 7. Start tailing output in background
    jobOutputs.set(job.id, "");
    tailer = sshStream(vmId, keyFile, "tail -n +1 -f /tmp/pi-rpc/out", (chunk) => {
      const existing = jobOutputs.get(job.id) || "";
      jobOutputs.set(job.id, existing + chunk);
    });

    // 8. Send the implementation prompt
    const prompt = buildPrompt(task, request.repo, baseBranch);
    const rpcMessage = JSON.stringify({ type: "user_message", content: prompt });
    // Escape single quotes for the shell, then write to FIFO
    const escapedMessage = rpcMessage.replace(/'/g, "'\\''");
    await sshExec(vmId, keyFile, `printf '%s\\n' '${escapedMessage}' >> /tmp/pi-rpc/in`);

    // 9. Poll for completion (check output for PR URL or errors)
    const maxWait = 30 * 60 * 1000; // 30 minutes
    const pollInterval = 15_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));

      const output = jobOutputs.get(job.id) || "";

      // Check if pi process is still running
      const tmuxCheck = await sshExec(vmId, keyFile, "tmux has-session -t pi-rpc 2>&1 && echo alive || echo dead");
      const isAlive = tmuxCheck.stdout.trim().endsWith("alive");

      // Look for PR URL in output
      const prMatch = output.match(/https:\/\/github\.com\/[^\s"']+\/pull\/\d+/);
      if (prMatch) {
        job.prUrl = prMatch[0];
        job.status = "done";
        job.completedAt = new Date().toISOString();

        feedStore.publish({
          agent: "implement",
          type: "task_completed",
          summary: `Implementation complete for task: ${task.title}`,
          detail: `PR created: ${job.prUrl}`,
          metadata: { taskId: task.id, jobId: job.id, vmId, prUrl: job.prUrl },
        });

        // Add a note on the board task
        try {
          boardStore.addNote(task.id, {
            author: "implement-agent",
            content: `Implementation complete. PR: ${job.prUrl}`,
            type: "update",
          });
          boardStore.addArtifacts(task.id, [{
            type: "url",
            url: job.prUrl,
            label: "Pull Request",
            addedBy: "implement-agent",
          }]);
        } catch {
          // task might have been deleted
        }

        break;
      }

      // If pi-rpc session is dead and no PR found, it's a failure
      if (!isAlive) {
        const errOutput = await sshExec(vmId, keyFile, "cat /tmp/pi-rpc/err 2>/dev/null || true");
        throw new Error(`pi agent exited without creating a PR. stderr: ${errOutput.stdout.slice(0, 500)}`);
      }
    }

    // Timeout check
    if (job.status === "running") {
      throw new Error("Implementation timed out after 30 minutes");
    }

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    job.status = "failed";
    job.error = errorMsg;
    job.completedAt = new Date().toISOString();

    feedStore.publish({
      agent: "implement",
      type: "task_failed",
      summary: `Implementation failed for task: ${task.title}`,
      detail: errorMsg,
      metadata: { taskId: task.id, jobId: job.id, vmId: job.vmId },
    });

    try {
      boardStore.addNote(task.id, {
        author: "implement-agent",
        content: `Implementation failed: ${errorMsg}`,
        type: "blocker",
      });
    } catch {
      // task might have been deleted
    }
  } finally {
    // Cleanup
    if (tailer) tailer.kill();
    if (keyFile) {
      try { unlinkSync(keyFile); } catch { /* ignore */ }
    }
    if (job.vmId) {
      await deleteVm(job.vmId);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const implementRoutes = new Hono();

// POST /board/tasks/:id/implement — kick off implementation
implementRoutes.post("/board/tasks/:id/implement", async (c) => {
  const taskId = c.req.param("id");
  const task = boardStore.getTask(taskId);
  if (!task) {
    return c.json({ error: "task not found" }, 404);
  }

  let body: ImplementRequest;
  try {
    body = (await c.req.json()) as ImplementRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.goldenCommitId || typeof body.goldenCommitId !== "string") {
    return c.json({ error: "goldenCommitId is required" }, 400);
  }
  if (!body.repo || typeof body.repo !== "string") {
    return c.json({ error: "repo is required" }, 400);
  }

  // Check env vars early
  if (!process.env.VERS_API_KEY) {
    return c.json({ error: "VERS_API_KEY is not configured on the server" }, 500);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "ANTHROPIC_API_KEY is not configured on the server" }, 500);
  }

  const job: ImplementJob = {
    id: ulid(),
    taskId,
    vmId: "",
    status: "starting",
    startedAt: new Date().toISOString(),
  };

  jobs.set(job.id, job);

  // Fire and forget — run implementation in background
  runImplementation(job, task, body).catch((err) => {
    console.error(`[implement] Unhandled error in job ${job.id}:`, err);
    if (job.status !== "done" && job.status !== "failed") {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
    }
  });

  return c.json({ jobId: job.id, taskId, status: job.status }, 202);
});

// GET /implement/jobs — list all jobs
implementRoutes.get("/implement/jobs", (c) => {
  const allJobs = Array.from(jobs.values()).sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt),
  );
  return c.json({ jobs: allJobs, count: allJobs.length });
});

// GET /implement/jobs/:id — get job status
implementRoutes.get("/implement/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) {
    return c.json({ error: "job not found" }, 404);
  }
  return c.json(job);
});

// GET /implement/jobs/:id/output — get pi's raw output
implementRoutes.get("/implement/jobs/:id/output", (c) => {
  const jobId = c.req.param("id");
  const job = jobs.get(jobId);
  if (!job) {
    return c.json({ error: "job not found" }, 404);
  }

  const output = jobOutputs.get(jobId) || "";
  return c.json({ jobId, output });
});






