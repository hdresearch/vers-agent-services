import { describe, it, expect } from "vitest";
import { parseCommand, COMMANDS } from "../bridge.js";

describe("parseCommand", () => {
  it("returns null for non-command text", () => {
    expect(parseCommand("hello world")).toBeNull();
    expect(parseCommand("   no command here")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("parses simple command without args", () => {
    const parsed = parseCommand("/status");
    expect(parsed).toEqual({ name: "status", args: "", raw: "/status" });
  });

  it("parses command with args", () => {
    const parsed = parseCommand("/spawn ada deploy the thing");
    expect(parsed).toEqual({
      name: "spawn",
      args: "ada deploy the thing",
      raw: "/spawn ada deploy the thing",
    });
  });

  it("parses command with leading whitespace", () => {
    const parsed = parseCommand("  /board open");
    expect(parsed).toEqual({ name: "board", args: "open", raw: "/board open" });
  });

  it("normalizes command name to lowercase", () => {
    const parsed = parseCommand("/STATUS");
    expect(parsed?.name).toBe("status");
  });

  it("handles /help", () => {
    const parsed = parseCommand("/help");
    expect(parsed?.name).toBe("help");
  });

  it("handles /notify with message", () => {
    const parsed = parseCommand("/notify deployment in 5 minutes");
    expect(parsed?.name).toBe("notify");
    expect(parsed?.args).toBe("deployment in 5 minutes");
  });

  it("handles /deploy with branch", () => {
    const parsed = parseCommand("/deploy feat/chat-bridge");
    expect(parsed?.name).toBe("deploy");
    expect(parsed?.args).toBe("feat/chat-bridge");
  });

  it("handles /deploy without branch", () => {
    const parsed = parseCommand("/deploy");
    expect(parsed?.name).toBe("deploy");
    expect(parsed?.args).toBe("");
  });

  it("handles /reap", () => {
    const parsed = parseCommand("/reap");
    expect(parsed?.name).toBe("reap");
  });
});

describe("COMMANDS", () => {
  it("has all expected commands", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("spawn");
    expect(names).toContain("status");
    expect(names).toContain("board");
    expect(names).toContain("reap");
    expect(names).toContain("deploy");
    expect(names).toContain("notify");
    expect(names).toContain("help");
  });

  it("each command has usage, description, and examples", () => {
    for (const cmd of COMMANDS) {
      expect(cmd.usage).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.examples.length).toBeGreaterThan(0);
    }
  });
});
