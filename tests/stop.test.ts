import { describe, it, expect, beforeEach } from "vitest";
import { stopConversation, stopEpochOf, runningBots } from "@/lib/server/runtime";
import { sendMessage, boot } from "@/lib/server/service";
import * as store from "@/lib/server/db";

describe("Execution Cancellation & Stop Handling (runtime.ts)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("increments stop epoch when stopping a conversation", async () => {
    const convId = "dm:test-stop-conv";
    const initialEpoch = stopEpochOf(convId);

    await stopConversation(convId);
    expect(stopEpochOf(convId)).toBe(initialEpoch + 1);

    await stopConversation(convId);
    expect(stopEpochOf(convId)).toBe(initialEpoch + 2);
  });

  it("aborts active streaming or suspended turn and marks message as stopped", async () => {
    const bots = await store.listBots();
    const bot = bots[0];
    const convId = `dm:${bot.id}`;

    // Start a turn with ask_user to suspend it in status: "streaming"
    await sendMessage(convId, "ask me something");
    await new Promise((r) => setTimeout(r, 600));

    // Verify it is currently in flight or suspended
    const beforeStop = await store.listMessages(convId);
    const inFlight = beforeStop.find((m) => m.role === "bot" && m.status === "streaming");
    expect(inFlight).toBeDefined();

    // Call stop
    await stopConversation(convId);

    // Verify message status transitioned to "stopped"
    const afterStop = await store.listMessages(convId);
    const stoppedMsg = afterStop.find((m) => m.id === inFlight!.id);
    expect(stoppedMsg?.status).toBe("stopped");

    // Verify runningBots map is empty for this conversation
    expect(runningBots(convId)).toEqual([]);
  });
});
