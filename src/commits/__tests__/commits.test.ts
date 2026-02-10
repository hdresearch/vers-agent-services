import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CommitStore,
  ValidationError,
  ConflictError,
  type RecordCommitInput,
} from "../store.js";
import { commitRoutes, commitStore } from "../routes.js";

// --- Store unit tests ---

function makeInput(overrides: Partial<RecordCommitInput> = {}): RecordCommitInput {
  return {
    commitId: "commit-" + Math.random().toString(36).slice(2, 8),
    vmId: "vm-" + Math.random().toString(36).slice(2, 8),
    ...overrides,
  };
}

describe("CommitStore", () => {
  let store: CommitStore;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "commits-test-"));
    filePath = join(tmpDir, "commits.jsonl");
    store = new CommitStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("record", () => {
    it("records a commit with defaults", () => {
      const entry = store.record(makeInput({ commitId: "c-1", vmId: "vm-1" }));
      expect(entry.commitId).toBe("c-1");
      expect(entry.vmId).toBe("vm-1");
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
    });

    it("records optional fields", () => {
      const entry = store.record(
        makeInput({
          commitId: "c-2",
          label: "golden-v3",
          agent: "orchestrator",
          tags: ["golden", "stable"],
          metadata: { reason: "fresh install" },
        })
      );
      expect(entry.label).toBe("golden-v3");
      expect(entry.agent).toBe("orchestrator");
      expect(entry.tags).toEqual(["golden", "stable"]);
      expect(entry.metadata).toEqual({ reason: "fresh install" });
    });

    it("rejects duplicate commitId", () => {
      store.record(makeInput({ commitId: "c-dup" }));
      expect(() => store.record(makeInput({ commitId: "c-dup" }))).toThrow(ConflictError);
    });

    it("validates required fields", () => {
      expect(() => store.record(makeInput({ commitId: "" }))).toThrow(ValidationError);
      expect(() => store.record(makeInput({ vmId: "" }))).toThrow(ValidationError);
    });

    it("validates tags is an array", () => {
      expect(() =>
        store.record(makeInput({ tags: "not-an-array" as any }))
      ).toThrow(ValidationError);
    });

    it("trims whitespace from fields", () => {
      const entry = store.record(
        makeInput({
          commitId: "  c-trim  ",
          vmId: "  vm-trim  ",
          label: "  my-label  ",
          agent: "  my-agent  ",
          tags: ["  tag1  ", "  tag2  "],
        })
      );
      expect(entry.commitId).toBe("c-trim");
      expect(entry.vmId).toBe("vm-trim");
      expect(entry.label).toBe("my-label");
      expect(entry.agent).toBe("my-agent");
      expect(entry.tags).toEqual(["tag1", "tag2"]);
    });
  });

  describe("get", () => {
    it("gets a commit by commitId", () => {
      store.record(makeInput({ commitId: "c-get" }));
      expect(store.get("c-get")).toBeTruthy();
      expect(store.get("c-get")!.commitId).toBe("c-get");
    });

    it("returns undefined for missing commit", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("lists all commits newest first", () => {
      store.record(makeInput({ commitId: "c-1" }));
      store.record(makeInput({ commitId: "c-2" }));
      store.record(makeInput({ commitId: "c-3" }));
      const all = store.list();
      expect(all).toHaveLength(3);
      expect(all[0].commitId).toBe("c-3");
      expect(all[2].commitId).toBe("c-1");
    });

    it("filters by tag", () => {
      store.record(makeInput({ commitId: "c-1", tags: ["golden", "stable"] }));
      store.record(makeInput({ commitId: "c-2", tags: ["wip"] }));
      store.record(makeInput({ commitId: "c-3", tags: ["golden"] }));
      const golden = store.list({ tag: "golden" });
      expect(golden).toHaveLength(2);
      expect(golden.every((e) => e.tags?.includes("golden"))).toBe(true);
    });

    it("filters by agent", () => {
      store.record(makeInput({ commitId: "c-1", agent: "orchestrator" }));
      store.record(makeInput({ commitId: "c-2", agent: "lt-infra" }));
      const result = store.list({ agent: "orchestrator" });
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("orchestrator");
    });

    it("filters by label", () => {
      store.record(makeInput({ commitId: "c-1", label: "infra" }));
      store.record(makeInput({ commitId: "c-2", label: "golden-v3" }));
      const result = store.list({ label: "infra" });
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("infra");
    });

    it("filters by vmId", () => {
      store.record(makeInput({ commitId: "c-1", vmId: "vm-a" }));
      store.record(makeInput({ commitId: "c-2", vmId: "vm-b" }));
      const result = store.list({ vmId: "vm-a" });
      expect(result).toHaveLength(1);
      expect(result[0].vmId).toBe("vm-a");
    });

    it("filters by since timestamp", async () => {
      store.record(makeInput({ commitId: "c-old" }));
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      store.record(makeInput({ commitId: "c-new" }));
      const result = store.list({ since: cutoff });
      expect(result).toHaveLength(1);
      expect(result[0].commitId).toBe("c-new");
    });

    it("combines multiple filters", () => {
      store.record(makeInput({ commitId: "c-1", agent: "orch", tags: ["golden"] }));
      store.record(makeInput({ commitId: "c-2", agent: "orch", tags: ["wip"] }));
      store.record(makeInput({ commitId: "c-3", agent: "lt", tags: ["golden"] }));
      const result = store.list({ agent: "orch", tag: "golden" });
      expect(result).toHaveLength(1);
      expect(result[0].commitId).toBe("c-1");
    });

    it("returns empty for no matches", () => {
      store.record(makeInput({ commitId: "c-1" }));
      const result = store.list({ agent: "nobody" });
      expect(result).toHaveLength(0);
    });
  });

  describe("remove", () => {
    it("removes a commit", () => {
      store.record(makeInput({ commitId: "c-del" }));
      expect(store.remove("c-del")).toBe(true);
      expect(store.get("c-del")).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it("returns false for missing commit", () => {
      expect(store.remove("nope")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("persists to JSONL and reloads", () => {
      store.record(makeInput({ commitId: "c-p1", label: "persisted" }));
      store.record(makeInput({ commitId: "c-p2", agent: "test-agent" }));

      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);

      // Reload from disk
      const store2 = new CommitStore(filePath);
      expect(store2.size).toBe(2);
      expect(store2.get("c-p1")?.label).toBe("persisted");
      expect(store2.get("c-p2")?.agent).toBe("test-agent");
    });

    it("rewrites file after remove", () => {
      store.record(makeInput({ commitId: "c-1" }));
      store.record(makeInput({ commitId: "c-2" }));
      store.remove("c-1");

      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(1);

      const store2 = new CommitStore(filePath);
      expect(store2.size).toBe(1);
      expect(store2.get("c-1")).toBeUndefined();
      expect(store2.get("c-2")).toBeTruthy();
    });
  });
});

// --- HTTP route tests ---

const app = new Hono();
app.route("/commits", commitRoutes);

function req(path: string, init?: RequestInit) {
  return app.request(`http://localhost/commits${path}`, init);
}

function recordCommit(overrides: Record<string, unknown> = {}) {
  const body = {
    commitId: "commit-" + Math.random().toString(36).slice(2, 8),
    vmId: "vm-" + Math.random().toString(36).slice(2, 8),
    ...overrides,
  };
  return req("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Commit Routes", () => {
  beforeEach(() => {
    commitStore.clear();
  });

  describe("POST / — Record", () => {
    it("records a commit and returns 201", async () => {
      const res = await recordCommit({ commitId: "c-http-1", vmId: "vm-1" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commitId).toBe("c-http-1");
      expect(body.vmId).toBe("vm-1");
      expect(body.id).toBeTruthy();
      expect(body.timestamp).toBeTruthy();
    });

    it("records with all optional fields", async () => {
      const res = await recordCommit({
        commitId: "c-full",
        vmId: "vm-1",
        label: "golden-v5",
        agent: "orchestrator",
        tags: ["golden", "stable"],
        metadata: { nodeVersion: "22" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.label).toBe("golden-v5");
      expect(body.agent).toBe("orchestrator");
      expect(body.tags).toEqual(["golden", "stable"]);
      expect(body.metadata).toEqual({ nodeVersion: "22" });
    });

    it("returns 400 for missing commitId", async () => {
      const res = await req("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vmId: "vm-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing vmId", async () => {
      const res = await req("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitId: "c-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 for duplicate commitId", async () => {
      await recordCommit({ commitId: "c-dup" });
      const res = await recordCommit({ commitId: "c-dup" });
      expect(res.status).toBe(409);
    });
  });

  describe("GET / — List", () => {
    it("lists all commits", async () => {
      await recordCommit({ commitId: "c-a" });
      await recordCommit({ commitId: "c-b" });
      const res = await req("");
      const body = await res.json();
      expect(body.count).toBe(2);
      expect(body.commits).toHaveLength(2);
    });

    it("filters by tag", async () => {
      await recordCommit({ commitId: "c-a", tags: ["golden"] });
      await recordCommit({ commitId: "c-b", tags: ["wip"] });
      const res = await req("?tag=golden");
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.commits[0].commitId).toBe("c-a");
    });

    it("filters by agent", async () => {
      await recordCommit({ commitId: "c-a", agent: "orchestrator" });
      await recordCommit({ commitId: "c-b", agent: "lt-infra" });
      const res = await req("?agent=orchestrator");
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.commits[0].agent).toBe("orchestrator");
    });

    it("filters by label", async () => {
      await recordCommit({ commitId: "c-a", label: "infra" });
      await recordCommit({ commitId: "c-b", label: "golden-v3" });
      const res = await req("?label=infra");
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.commits[0].label).toBe("infra");
    });

    it("filters by since", async () => {
      await recordCommit({ commitId: "c-old" });
      await new Promise((r) => setTimeout(r, 10));
      const since = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      await recordCommit({ commitId: "c-new" });
      const res = await req(`?since=${encodeURIComponent(since)}`);
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.commits[0].commitId).toBe("c-new");
    });

    it("returns empty for no matches", async () => {
      await recordCommit({ commitId: "c-a" });
      const res = await req("?agent=nobody");
      const body = await res.json();
      expect(body.count).toBe(0);
      expect(body.commits).toEqual([]);
    });
  });

  describe("GET /:id — Get", () => {
    it("returns a single commit", async () => {
      await recordCommit({ commitId: "c-get" });
      const res = await req("/c-get");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commitId).toBe("c-get");
    });

    it("returns 404 for missing commit", async () => {
      const res = await req("/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id — Remove", () => {
    it("deletes a commit", async () => {
      await recordCommit({ commitId: "c-del" });
      const res = await req("/c-del", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);

      const getRes = await req("/c-del");
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for missing commit", async () => {
      const res = await req("/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
