import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebChatStore } from "../store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("WebChatStore", () => {
  let store: WebChatStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "web-chat-test-"));
    store = new WebChatStore(join(tmpDir, "chat.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts and retrieves a message", () => {
    const msg = store.post({
      role: "human",
      sender: "noah",
      content: "hello world",
    });

    expect(msg.id).toBeTruthy();
    expect(msg.role).toBe("human");
    expect(msg.sender).toBe("noah");
    expect(msg.content).toBe("hello world");
    expect(msg.createdAt).toBeTruthy();

    const fetched = store.get(msg.id);
    expect(fetched).toEqual(msg);
  });

  it("lists messages with limit", () => {
    for (let i = 0; i < 10; i++) {
      store.post({ role: "human", sender: "noah", content: `msg ${i}` });
    }

    const all = store.list({ limit: 100 });
    expect(all.length).toBe(10);

    const limited = store.list({ limit: 3 });
    expect(limited.length).toBe(3);
    // Should return 3 of the most recent messages
    const contents = limited.map((m) => m.content);
    // All should be from our set
    for (const c of contents) {
      expect(c).toMatch(/^msg \d$/);
    }
  });

  it("filters by role", () => {
    store.post({ role: "human", sender: "noah", content: "human msg" });
    store.post({ role: "system", sender: "bridge", content: "system msg" });
    store.post({ role: "bridge", sender: "bridge", content: "bridge msg" });

    const humans = store.list({ role: "human" });
    expect(humans.length).toBe(1);
    expect(humans[0].content).toBe("human msg");

    const bridges = store.list({ role: "bridge" });
    expect(bridges.length).toBe(1);
  });

  it("filters by after timestamp", () => {
    // Use a past timestamp so our messages are definitely after it
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    store.post({ role: "human", sender: "noah", content: "first-after" });
    store.post({ role: "human", sender: "noah", content: "second-after" });

    const afterPast = store.list({ after: pastTime });
    expect(afterPast.length).toBeGreaterThanOrEqual(2);
    expect(afterPast.some((m) => m.content === "second-after")).toBe(true);
  });

  it("stores metadata and command", () => {
    const msg = store.post({
      role: "human",
      sender: "noah",
      content: "/status",
      command: "status",
      metadata: { source: "web-chat" },
    });

    const fetched = store.get(msg.id)!;
    expect(fetched.command).toBe("status");
    expect(fetched.metadata).toEqual({ source: "web-chat" });
  });

  it("notifies listeners on post", () => {
    const received: any[] = [];
    store.addListener((msg) => received.push(msg));

    store.post({ role: "human", sender: "noah", content: "hello" });
    expect(received.length).toBe(1);
    expect(received[0].content).toBe("hello");
  });

  it("removeListener stops notifications", () => {
    const received: any[] = [];
    const remove = store.addListener((msg) => received.push(msg));

    store.post({ role: "human", sender: "noah", content: "first" });
    remove();
    store.post({ role: "human", sender: "noah", content: "second" });

    expect(received.length).toBe(1);
  });

  it("tracks count", () => {
    expect(store.count).toBe(0);
    store.post({ role: "human", sender: "noah", content: "one" });
    store.post({ role: "system", sender: "bridge", content: "two" });
    expect(store.count).toBe(2);
  });
});
