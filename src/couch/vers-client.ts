/**
 * Minimal Vers platform API client for VM provisioning.
 * Used by the couch service to spawn sandboxed guest VMs.
 */

const VERS_API_BASE = "https://api.vers.sh/api/v1";

export interface VersVM {
  vm_id: string;
  state: string;
  created_at: string;
}

export class VersClient {
  constructor(
    private apiKey: string,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${VERS_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vers API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  /** Restore a VM from a commit (golden image) */
  async restoreFromCommit(commitId: string): Promise<VersVM> {
    return this.request("POST", `/vm/from_commit`, { commit_id: commitId });
  }

  /** Delete a VM */
  async deleteVM(vmId: string): Promise<void> {
    await this.request("DELETE", `/vm/${vmId}`);
  }

  /** Get VM state */
  async getVM(vmId: string): Promise<VersVM> {
    return this.request("GET", `/vm/${vmId}`);
  }

  /** Wait for VM to be running (poll with backoff) */
  async waitForRunning(vmId: string, timeoutMs = 60_000): Promise<VersVM> {
    const start = Date.now();
    let delay = 1000;
    while (Date.now() - start < timeoutMs) {
      const vm = await this.getVM(vmId);
      if (vm.state === "running") return vm;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 5000);
    }
    throw new Error(`VM ${vmId} did not reach running state within ${timeoutMs}ms`);
  }
}



