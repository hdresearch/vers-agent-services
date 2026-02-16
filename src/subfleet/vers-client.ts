/**
 * Vers API client for sub-fleet VM lifecycle.
 *
 * - POST /vm/from_commit  → spawn VM from golden commit
 * - DELETE /vm/:id        → destroy VM
 * - GET /vm               → list all VMs (no GET /vm/:id)
 */

export interface VersClientOpts {
  apiBase?: string;
  apiKey: string;
}

export interface VersVM {
  vm_id: string;
  status: string;
  [key: string]: unknown;
}

export class VersClient {
  private apiBase: string;
  private apiKey: string;

  constructor(opts: VersClientOpts) {
    this.apiBase = opts.apiBase || "https://api.vers.sh/api/v1";
    this.apiKey = opts.apiKey;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async spawnFromCommit(commitId: string): Promise<{ vmId: string }> {
    const resp = await fetch(`${this.apiBase}/vm/from_commit`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ commit_id: commitId }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Vers API POST /vm/from_commit failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as { vm_id: string };
    return { vmId: data.vm_id };
  }

  async destroyVM(vmId: string): Promise<void> {
    const resp = await fetch(`${this.apiBase}/vm/${vmId}`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Vers API DELETE /vm/${vmId} failed (${resp.status})`);
    }
  }

  async listVMs(): Promise<VersVM[]> {
    const resp = await fetch(`${this.apiBase}/vm`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!resp.ok) {
      throw new Error(`Vers API GET /vm failed (${resp.status})`);
    }

    return (await resp.json()) as VersVM[];
  }
}
