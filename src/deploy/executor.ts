import { execSync } from "node:child_process";
import { DeployStore, type DeployRecord } from "./store.js";

const VERS_API = "https://api.vers.sh/api/v1";
const VERS_API_KEY = process.env.VERS_DEPLOY_API_KEY || "9370b900-e31a-4f0c-b92d-0829df4c8e1592fe3dae0b420da046d1e22dd307ae6787f9392915464f76bcfe02e75e80fe25";
const INFRA_VM_ID = process.env.VERS_INFRA_VM_ID || "a9a83d7f-c092-404a-bf44-cf21b96a2170";
const REPO_DIR = process.env.DEPLOY_REPO_DIR || "/root/workspace/vers-agent-services";
const SERVICE_NAME = process.env.DEPLOY_SERVICE_NAME || "agent-services";
const HEALTH_URL = process.env.DEPLOY_HEALTH_URL || "http://localhost:3000/health";
const INFRA_URL = process.env.VERS_INFRA_URL || "";

// Logger helper — posts to /log on infra
async function logToService(text: string, agent = "ada-deploy"): Promise<void> {
  try {
    const url = INFRA_URL ? `${INFRA_URL}/log` : "http://localhost:3000/log";
    const token = process.env.VERS_AUTH_TOKEN || "";
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ agent, text }),
    }).catch(() => {});
  } catch {}
}

// Notification helper — uses deep-linked notifications when available
async function notify(title: string, body: string, type = "alert", priority = "high", uiPath = "/ui/#services"): Promise<void> {
  try {
    const { createDeepLinkedNotification } = await import("../notifications/deeplink.js");
    const baseUrl = INFRA_URL || "http://localhost:3000";
    createDeepLinkedNotification({ type, title, body, priority, source: "deploy", uiPath }, baseUrl);
  } catch {
    // Fallback: direct POST if import fails (e.g. running standalone)
    try {
      const url = INFRA_URL ? `${INFRA_URL}/notifications` : "http://localhost:3000/notifications";
      const token = process.env.VERS_AUTH_TOKEN || "";
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ title, body, type, priority, source: "deploy" }),
      }).catch(() => {});
    } catch {}
  }
}

function shell(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd: cwd || REPO_DIR,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  }).trim();
}

function getCurrentCommit(): string {
  return shell("git rev-parse HEAD");
}

async function snapshotInfra(): Promise<string | null> {
  try {
    const resp = await fetch(`${VERS_API}/vm/${INFRA_VM_ID}/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VERS_API_KEY}`,
      },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Snapshot failed: ${resp.status} ${text}`);
      return null;
    }
    const data = await resp.json() as any;
    return data.commit || data.commitId || data.id || "snapshot-ok";
  } catch (err) {
    console.error("Snapshot error:", err);
    return null;
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return false;
    const data = await resp.json() as any;
    return data.status === "ok";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deploy mutex
let deploying = false;

export function isDeploying(): boolean {
  return deploying;
}

export async function executeDeploy(
  store: DeployStore,
  branch: string,
  commit: string | undefined,
  triggeredBy: string,
): Promise<DeployRecord> {
  if (deploying) {
    throw new Error("Deploy already in progress");
  }
  deploying = true;

  const record = store.createRecord(branch, triggeredBy);

  try {
    await logToService(`🚀 Deploy started: branch=${branch} commit=${commit || "latest"} by=${triggeredBy}`);

    // Step 1: Record previous commit
    const previousCommit = getCurrentCommit();
    store.updateRecord(record.id, { previousCommit });

    // Step 2: Snapshot infra for rollback
    await logToService("📸 Creating infra snapshot...");
    const snapshotCommit = await snapshotInfra();
    store.updateRecord(record.id, { snapshotCommit });
    if (snapshotCommit) {
      await logToService(`📸 Snapshot created: ${snapshotCommit}`);
    } else {
      await logToService("⚠️ Snapshot failed — continuing without rollback point");
    }

    // Step 3: Git fetch and checkout
    await logToService(`📦 Fetching and checking out ${branch}...`);
    shell("git fetch origin");
    shell(`git checkout ${branch}`);
    shell(`git pull origin ${branch}`);
    if (commit) {
      shell(`git checkout ${commit}`);
    }
    const newCommit = getCurrentCommit();
    store.updateRecord(record.id, { commit: newCommit });
    await logToService(`📦 Now at commit: ${newCommit}`);

    // Step 4: Build
    await logToService("🔨 Building...");
    shell("npm run build");
    await logToService("🔨 Build complete");

    // Step 5: Restart service
    await logToService("🔄 Restarting service...");
    try {
      shell(`systemctl restart ${SERVICE_NAME}`, "/");
    } catch (err) {
      // systemctl may fail if we ARE the service — the restart kills us
      // In that case, this code won't execute. But if we're running separately:
      await logToService(`⚠️ Restart command returned error (may be expected): ${err}`);
    }

    // Step 6: Wait and health check
    await logToService("⏳ Waiting 5s for service to start...");
    await sleep(5000);

    const healthy = await checkHealth();

    if (healthy) {
      store.updateRecord(record.id, {
        success: true,
        completedAt: new Date().toISOString(),
      });
      await logToService(`✅ Deploy successful! commit=${newCommit}`);
      await notify(
        "Deploy Successful",
        `Branch: ${branch}\nCommit: ${newCommit}\nPrevious: ${previousCommit}`,
        "update",
        "normal",
      );
    } else {
      // Rollback
      await logToService(`❌ Health check failed! Rolling back to ${previousCommit}...`);
      await notify(
        "Deploy Failed — Rolling Back",
        `Branch: ${branch}\nCommit: ${newCommit}\nRolling back to: ${previousCommit}`,
        "alert",
        "critical",
      );

      shell(`git checkout ${previousCommit}`);
      shell("npm run build");
      try {
        shell(`systemctl restart ${SERVICE_NAME}`, "/");
      } catch {}
      await sleep(5000);

      const rollbackHealthy = await checkHealth();
      store.updateRecord(record.id, {
        success: false,
        error: "Health check failed after deploy",
        rollbackCommit: previousCommit,
        completedAt: new Date().toISOString(),
      });

      if (rollbackHealthy) {
        await logToService(`🔄 Rollback successful — back on ${previousCommit}`);
      } else {
        await logToService(`🔥 CRITICAL: Rollback also failed! Manual intervention needed.`);
        await notify(
          "CRITICAL: Rollback Failed",
          `Both deploy and rollback failed. Manual intervention required.\nAttempted: ${newCommit}\nRollback to: ${previousCommit}`,
          "alert",
          "critical",
        );
      }
    }
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    store.updateRecord(record.id, {
      success: false,
      error: errorMsg,
      completedAt: new Date().toISOString(),
    });
    await logToService(`❌ Deploy error: ${errorMsg}`);
    await notify("Deploy Error", errorMsg, "alert", "critical");
  } finally {
    deploying = false;
  }

  return store.getHistory(1)[0] || record;
}
