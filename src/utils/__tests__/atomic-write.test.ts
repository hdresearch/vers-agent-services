import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFileSync, recoverTmpFile } from "../atomic-write.js";

describe("atomicWriteFileSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file atomically (no .tmp left behind)", () => {
    const filePath = join(tmpDir, "data.json");
    const data = JSON.stringify({ hello: "world" });
    atomicWriteFileSync(filePath, data);

    expect(readFileSync(filePath, "utf-8")).toBe(data);
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });

  it("creates parent directories if missing", () => {
    const filePath = join(tmpDir, "nested", "deep", "data.json");
    atomicWriteFileSync(filePath, "test");

    expect(readFileSync(filePath, "utf-8")).toBe("test");
  });

  it("overwrites existing file atomically", () => {
    const filePath = join(tmpDir, "data.json");
    atomicWriteFileSync(filePath, "v1");
    atomicWriteFileSync(filePath, "v2");

    expect(readFileSync(filePath, "utf-8")).toBe("v2");
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });
});

describe("recoverTmpFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "atomic-recover-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'ok' when main file is valid", () => {
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath, '{"tasks":[]}');

    const result = recoverTmpFile(filePath);
    expect(result).toBe("ok");
  });

  it("returns 'ok' and cleans up stale .tmp when main is valid", () => {
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath, '{"tasks":[]}');
    writeFileSync(filePath + ".tmp", '{"tasks":[{"id":"1"}]}');

    const result = recoverTmpFile(filePath);
    expect(result).toBe("ok");
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });

  it("recovers from .tmp when main file is missing", () => {
    const filePath = join(tmpDir, "data.json");
    const tmpData = '{"tasks":[{"id":"recovered"}]}';
    writeFileSync(filePath + ".tmp", tmpData);

    const result = recoverTmpFile(filePath);
    expect(result).toBe("recovered");
    expect(readFileSync(filePath, "utf-8")).toBe(tmpData);
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });

  it("recovers from .tmp when main file is corrupt", () => {
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath, "CORRUPT{{{not json");
    const tmpData = '{"tasks":[{"id":"good"}]}';
    writeFileSync(filePath + ".tmp", tmpData);

    const result = recoverTmpFile(filePath);
    expect(result).toBe("recovered");
    expect(readFileSync(filePath, "utf-8")).toBe(tmpData);
  });

  it("returns 'empty' when both files are missing", () => {
    const filePath = join(tmpDir, "data.json");

    const result = recoverTmpFile(filePath);
    expect(result).toBe("empty");
  });

  it("returns 'empty' when main is corrupt and .tmp is also corrupt", () => {
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath, "CORRUPT");
    writeFileSync(filePath + ".tmp", "ALSO CORRUPT");

    const result = recoverTmpFile(filePath);
    expect(result).toBe("empty");
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });

  it("returns 'empty' when main is missing and .tmp is corrupt", () => {
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath + ".tmp", "NOT VALID JSON");

    const result = recoverTmpFile(filePath);
    expect(result).toBe("empty");
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });

  it("uses custom validator for JSONL files", () => {
    const filePath = join(tmpDir, "data.jsonl");
    const jsonlData = '{"id":"1"}\n{"id":"2"}\n';
    writeFileSync(filePath + ".tmp", jsonlData);

    const result = recoverTmpFile(filePath, (content) => {
      for (const line of content.split("\n")) {
        if (line.trim()) JSON.parse(line);
      }
    });

    expect(result).toBe("recovered");
    expect(readFileSync(filePath, "utf-8")).toBe(jsonlData);
  });
});

describe("crash simulation: store recovery with .tmp files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-crash-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("BoardStore recovers from .tmp on startup", async () => {
    const filePath = join(tmpDir, "board.json");
    const taskData = {
      tasks: [{ id: "01", title: "Rescued task", status: "open", assignee: undefined,
        tags: [], dependencies: [], createdBy: "agent", createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z", notes: [], artifacts: [], score: 0 }]
    };
    // Simulate crash: only .tmp exists, main is missing
    writeFileSync(filePath + ".tmp", JSON.stringify(taskData));

    const { BoardStore } = await import("../../board/store.js");
    const store = new BoardStore(filePath);
    const tasks = store.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("Rescued task");
    expect(existsSync(filePath + ".tmp")).toBe(false);
  });

  it("BoardStore recovers from .tmp when main is corrupt", async () => {
    const filePath = join(tmpDir, "board-corrupt.json");
    writeFileSync(filePath, "{{{{CORRUPT");
    const taskData = {
      tasks: [{ id: "02", title: "Saved task", status: "done", assignee: undefined,
        tags: [], dependencies: [], createdBy: "agent", createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z", notes: [], artifacts: [], score: 0 }]
    };
    writeFileSync(filePath + ".tmp", JSON.stringify(taskData));

    const { BoardStore } = await import("../../board/store.js");
    const store = new BoardStore(filePath);
    const tasks = store.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("Saved task");
  });

  it("RegistryStore recovers from .tmp on startup", async () => {
    const filePath = join(tmpDir, "registry.json");
    const vmData = {
      vms: [{ id: "vm-1", name: "test-vm", role: "worker", status: "running",
        address: "10.0.0.1", registeredBy: "agent", registeredAt: "2025-01-01T00:00:00.000Z",
        lastSeen: new Date().toISOString() }]
    };
    writeFileSync(filePath + ".tmp", JSON.stringify(vmData));

    const { RegistryStore } = await import("../../registry/store.js");
    const store = new RegistryStore(filePath);
    const vm = store.get("vm-1");
    expect(vm).toBeDefined();
    expect(vm!.name).toBe("test-vm");
  });

  it("ReportsStore recovers from .tmp on startup", async () => {
    const filePath = join(tmpDir, "reports.json");
    const reportData = {
      reports: [{ id: "r1", title: "Test Report", author: "agent",
        content: "content", tags: [], createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z" }]
    };
    writeFileSync(filePath + ".tmp", JSON.stringify(reportData));

    const { ReportsStore } = await import("../../reports/store.js");
    const store = new ReportsStore(filePath);
    const report = store.get("r1");
    expect(report).toBeDefined();
    expect(report!.title).toBe("Test Report");
  });
});
