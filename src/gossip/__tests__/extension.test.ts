import { describe, it, expect } from "vitest";
import {
  GOSSIP_EXTENSION_NAME,
  GOSSIP_EXTENSION_DESCRIPTION,
  GOSSIP_EXTENSION_CONTENT,
  GOSSIP_TOOL_DEFINITIONS,
} from "../extension.js";

describe("Gossip Extension", () => {
  it("has a valid name and description", () => {
    expect(GOSSIP_EXTENSION_NAME).toBe("gossip-tools");
    expect(GOSSIP_EXTENSION_DESCRIPTION).toBeTruthy();
  });

  it("has non-empty content", () => {
    expect(GOSSIP_EXTENSION_CONTENT.length).toBeGreaterThan(100);
  });

  it("content references all 4 tools", () => {
    expect(GOSSIP_EXTENSION_CONTENT).toContain("gossip_send");
    expect(GOSSIP_EXTENSION_CONTENT).toContain("gossip_check");
    expect(GOSSIP_EXTENSION_CONTENT).toContain("gossip_reply");
    expect(GOSSIP_EXTENSION_CONTENT).toContain("gossip_broadcast");
  });

  it("defines 4 tool definitions", () => {
    expect(GOSSIP_TOOL_DEFINITIONS).toHaveLength(4);
    const names = GOSSIP_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("gossip_send");
    expect(names).toContain("gossip_check");
    expect(names).toContain("gossip_reply");
    expect(names).toContain("gossip_broadcast");
  });

  it("each tool has required fields", () => {
    for (const tool of GOSSIP_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.required).toBeTruthy();
      expect(tool.parameters.properties).toBeTruthy();
    }
  });

  it("gossip_send requires from, to, type, subject, body", () => {
    const send = GOSSIP_TOOL_DEFINITIONS.find((t) => t.name === "gossip_send")!;
    expect(send.parameters.required).toEqual(["from", "to", "type", "subject", "body"]);
  });

  it("gossip_check requires agent", () => {
    const check = GOSSIP_TOOL_DEFINITIONS.find((t) => t.name === "gossip_check")!;
    expect(check.parameters.required).toEqual(["agent"]);
  });

  it("gossip_reply requires from, replyTo, body", () => {
    const reply = GOSSIP_TOOL_DEFINITIONS.find((t) => t.name === "gossip_reply")!;
    expect(reply.parameters.required).toEqual(["from", "replyTo", "body"]);
  });

  it("gossip_broadcast requires from, type, subject, body", () => {
    const broadcast = GOSSIP_TOOL_DEFINITIONS.find((t) => t.name === "gossip_broadcast")!;
    expect(broadcast.parameters.required).toEqual(["from", "type", "subject", "body"]);
  });
});
