import { describe, it, expect, beforeEach } from "vitest";
import { respondToApproval } from "@/lib/server/runtime";
import { boot, createBot } from "@/lib/server/service";
import * as store from "@/lib/server/db";

describe("Human-in-the-Loop: Tool Approval Mechanisms (runtime.ts)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("throws descriptive error when attempting to approve expired or non-existent tool call", async () => {
    const fakeConv = "dm:non-existent-conv";
    await expect(
      respondToApproval(fakeConv, "fake-bot", "call-xyz", true)
    ).rejects.toThrow("That request is no longer waiting. The bot may have restarted.");
  });

  it("supports configuring bot with full autonomy (approval: full)", async () => {
    const autonomousBot = await createBot({
      name: "Autonomous Bot",
      handle: "autonomous",
      title: "Worker",
      description: "Full autonomy mode",
      instructions: "Execute without gating.",
      emoji: "🚀",
      color: "#059669",
      model: "mock",
      tools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: false },
      connections: [],
      approval: "full",
      pinned: false,
    });

    expect(autonomousBot.approval).toBe("full");

    const fetched = await store.getBot(autonomousBot.id);
    expect(fetched?.approval).toBe("full");
  });

  it("supports configuring bot with gated approval (approval: ask)", async () => {
    const gatedBot = await createBot({
      name: "Gated Bot",
      handle: "gated",
      title: "Worker",
      description: "Approval required mode",
      instructions: "Gate privileged tools.",
      emoji: "🛡️",
      color: "#dc2626",
      model: "mock",
      tools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: false },
      connections: [],
      approval: "ask",
      pinned: false,
    });

    expect(gatedBot.approval).toBe("ask");

    const fetched = await store.getBot(gatedBot.id);
    expect(fetched?.approval).toBe("ask");
  });
});
