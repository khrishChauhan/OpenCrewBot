import { describe, it, expect, beforeEach } from "vitest";
import { runRoom, roomConversationId, messageText } from "@/lib/server/rooms";
import * as store from "@/lib/server/db";
import { boot } from "@/lib/server/service";
import type { Room, ChatMessage } from "@/lib/shared/types";

describe("Room Routing & Multi-Agent Collaboration (rooms.ts)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("formats room conversation ID correctly", () => {
    expect(roomConversationId("room123")).toBe("room:room123");
  });

  it("extracts plain text from complex message parts", () => {
    const msg: ChatMessage = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      createdAt: new Date().toISOString(),
      status: "done",
      parts: [
        { kind: "text", text: "Line 1" },
        { kind: "reasoning", text: "Internal thought" },
        { kind: "text", text: "Line 2" },
      ],
    };
    expect(messageText(msg)).toBe("Line 1\nLine 2");
  });

  describe("Room Turn Execution with Mock Model", () => {
    it("routes unmentioned message to lead bot in auto room", async () => {
      const bots = await store.listBots();
      expect(bots.length).toBeGreaterThanOrEqual(2);
      const leadBot = bots[0];
      const otherBot = bots[1];

      const room: Room = {
        id: "room-auto-test",
        name: "Auto Room",
        topic: "Testing lead fallback",
        emoji: "🧪",
        memberIds: [leadBot.id, otherBot.id],
        leadId: leadBot.id,
        responder: "auto",
        pinned: false,
        createdAt: new Date().toISOString(),
      };
      await store.saveRoom(room);

      const convId = roomConversationId(room.id);
      const userMsg: ChatMessage = {
        id: "user-msg-1",
        conversationId: convId,
        role: "user",
        createdAt: new Date().toISOString(),
        status: "done",
        parts: [{ kind: "text", text: "Hello team, who is listening?" }],
      };
      await store.saveMessage(userMsg);

      await runRoom(room, userMsg);

      const transcript = await store.listMessages(convId);
      const botReplies = transcript.filter((m) => m.role === "bot");

      expect(botReplies.length).toBe(1);
      expect(botReplies[0].botId).toBe(leadBot.id);
      expect(botReplies[0].route?.by).toBe("lead");
    });

    it("routes message with @mention to only the mentioned member", async () => {
      const bots = await store.listBots();
      const botA = bots[0];
      const botB = bots[1];

      const room: Room = {
        id: "room-mention-test",
        name: "Mention Room",
        topic: "Testing mentions",
        emoji: "🎯",
        memberIds: [botA.id, botB.id],
        leadId: botA.id,
        responder: "lead",
        pinned: false,
        createdAt: new Date().toISOString(),
      };
      await store.saveRoom(room);

      const convId = roomConversationId(room.id);
      const userMsg: ChatMessage = {
        id: "user-msg-mention",
        conversationId: convId,
        role: "user",
        createdAt: new Date().toISOString(),
        status: "done",
        parts: [{ kind: "text", text: `Calling @${botB.handle} for input!` }],
      };
      await store.saveMessage(userMsg);

      await runRoom(room, userMsg);

      const transcript = await store.listMessages(convId);
      const botReplies = transcript.filter((m) => m.role === "bot");

      expect(botReplies.length).toBe(1);
      expect(botReplies[0].botId).toBe(botB.id);
      expect(botReplies[0].route?.by).toBe("mention");
    });

    it("routes to all members when message contains @everyone", async () => {
      const bots = await store.listBots();
      const botA = bots[0];
      const botB = bots[1];

      const room: Room = {
        id: "room-all-test",
        name: "Broadcast Room",
        topic: "Testing broadcast",
        emoji: "📢",
        memberIds: [botA.id, botB.id],
        leadId: botA.id,
        responder: "lead",
        pinned: false,
        createdAt: new Date().toISOString(),
      };
      await store.saveRoom(room);

      const convId = roomConversationId(room.id);
      const userMsg: ChatMessage = {
        id: "user-msg-all",
        conversationId: convId,
        role: "user",
        createdAt: new Date().toISOString(),
        status: "done",
        parts: [{ kind: "text", text: "Attention @everyone, status update please" }],
      };
      await store.saveMessage(userMsg);

      await runRoom(room, userMsg);

      const transcript = await store.listMessages(convId);
      const botReplies = transcript.filter((m) => m.role === "bot");

      expect(botReplies.length).toBe(2);
      const respondingIds = botReplies.map((b) => b.botId);
      expect(respondingIds).toContain(botA.id);
      expect(respondingIds).toContain(botB.id);
    });
  });
});
