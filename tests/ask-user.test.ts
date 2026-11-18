import { describe, it, expect, beforeEach } from "vitest";
import { sendMessage, boot } from "@/lib/server/service";
import { answerQuestion } from "@/lib/server/runtime";
import * as store from "@/lib/server/db";
import type { Part } from "@/lib/shared/types";

type QuestionPart = Extract<Part, { kind: "question" }>;

describe("Human-in-the-Loop: Question Suspension & Answer (ask_user)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("suspends turn when bot invokes ask_user and resumes when answered", async () => {
    const bots = await store.listBots();
    const bot = bots.find((b) => b.tools.askUser);
    expect(bot).toBeDefined();

    const convId = `dm:${bot!.id}`;

    // 1. Trigger ask_user via mock keyword "ask me"
    // runTurn runs asynchronously in service.sendMessage
    await sendMessage(convId, "ask me something");

    // Wait a brief tick for the turn folder to process and suspend
    await new Promise((r) => setTimeout(r, 600));

    // 2. Verify message in DB is suspended with question part
    const messages = await store.listMessages(convId);
    const botMsg = messages.find((m) => m.role === "bot" && m.parts.some((p) => p.kind === "question"));
    expect(botMsg).toBeDefined();

    const qPart = botMsg!.parts.find((p) => p.kind === "question") as QuestionPart;
    expect(qPart).toBeDefined();
    expect(qPart.question).toContain("short answers or detailed");
    expect(qPart.options.length).toBeGreaterThan(0);

    // 3. Resume by answering the question
    await answerQuestion(convId, bot!.id, qPart.toolCallId, "Short");

    // Wait a brief tick for completion
    await new Promise((r) => setTimeout(r, 600));

    // 4. Verify turn completed with the answer recorded
    const updatedMessages = await store.listMessages(convId);
    const completedMsg = updatedMessages.find((m) => m.id === botMsg!.id);
    expect(completedMsg?.status).toBe("done");

    const updatedQPart = completedMsg?.parts.find((p) => p.kind === "question") as QuestionPart;
    expect(updatedQPart.answer).toBe("Short");
  });

  it("throws error when answering non-existent or expired question", async () => {
    const fakeConv = "dm:non-existent-conv";
    await expect(
      answerQuestion(fakeConv, "fake-bot", "call-123", "Any answer")
    ).rejects.toThrow("That question is no longer waiting");
  });
});
