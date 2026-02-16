import { readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/atomic-write.js";

export interface DeployRecord {
  id: string;
  triggeredAt: string;
  completedAt: string | null;
  branch: string;
  commit: string | null;
  previousCommit: string | null;
  snapshotCommit: string | null;
  rollbackCommit: string | null;
  success: boolean;
  error: string | null;
  triggeredBy: string;
}

const DEFAULT_DATA_FILE = process.env.DEPLOY_DATA_FILE || "data/deploy-history.json";
const MAX_HISTORY = 50;

export class DeployStore {
  private history: DeployRecord[] = [];
  private dataFile: string;

  constructor(dataFile?: string) {
    this.dataFile = dataFile || DEFAULT_DATA_FILE;
    this.load();
  }

  private load(): void {
    if (existsSync(this.dataFile)) {
      try {
        this.history = JSON.parse(readFileSync(this.dataFile, "utf-8"));
      } catch {
        this.history = [];
      }
    }
  }

  private save(): void {
    atomicWriteFileSync(this.dataFile, JSON.stringify(this.history, null, 2));
  }

  createRecord(branch: string, triggeredBy: string): DeployRecord {
    const record: DeployRecord = {
      id: `deploy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      triggeredAt: new Date().toISOString(),
      completedAt: null,
      branch,
      commit: null,
      previousCommit: null,
      snapshotCommit: null,
      rollbackCommit: null,
      success: false,
      error: null,
      triggeredBy,
    };
    this.history.unshift(record);
    // Trim to MAX_HISTORY
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(0, MAX_HISTORY);
    }
    this.save();
    return record;
  }

  updateRecord(id: string, updates: Partial<DeployRecord>): DeployRecord | null {
    const record = this.history.find((r) => r.id === id);
    if (!record) return null;
    Object.assign(record, updates);
    this.save();
    return record;
  }

  getLastDeploy(): DeployRecord | null {
    return this.history[0] || null;
  }

  getHistory(limit = 20): DeployRecord[] {
    return this.history.slice(0, limit);
  }

  getStatus(): {
    lastDeployTime: string | null;
    currentCommit: string | null;
    lastResult: DeployRecord | null;
    deploying: boolean;
  } {
    const last = this.getLastDeploy();
    return {
      lastDeployTime: last?.triggeredAt || null,
      currentCommit: last?.success ? last.commit : (last?.rollbackCommit || last?.previousCommit || null),
      lastResult: last,
      deploying: last ? last.completedAt === null : false,
    };
  }
}
