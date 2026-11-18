import { describe, it, expect, beforeEach } from "vitest";
import {
  boot,
  createBot,
  updateBot,
  deleteBot,
  createRoom,
  updateRoom,
  deleteRoom,
} from "@/lib/server/service";
import * as store from "@/lib/server/db";
import { InputError } from "@/lib/server/errors";
import type { BotInput, RoomInput } from "@/lib/shared/types";

describe("Service Layer: Agent & Room Lifecycle (service.ts)", () => {
  beforeEach(async () => {
    await boot();
  });

  describe("Bot Lifecycle & Validation", () => {
    it("creates a new bot with valid input and default fields", async () => {
      const input: BotInput = {
        name: "Service Bot",
        handle: "servicebot",
        title: "Assistant",
        description: "A bot created via service layer",
        instructions: "Assist with service tests.",
        emoji: "⚡",
        color: "#4f46e5",
        model: "MiniMaxAI/MiniMax-M3",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true },
        connections: [],
        approval: "ask",
        pinned: false,
      };

      const created = await createBot(input);
      expect(created.id).toBeDefined();
      expect(created.name).toBe("Service Bot");
      expect(created.handle).toBe("servicebot");

      // Verify persisted in DB
      const fetched = await store.getBot(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Service Bot");
    });

    it("rejects bot creation when name is empty", async () => {
      const invalid: BotInput = {
        name: "   ",
        handle: "emptybot",
        title: "Bad",
        description: "",
        instructions: "",
        emoji: "❌",
        color: "#000",
        model: "mock",
        tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "ask",
        pinned: false,
      };

      await expect(createBot(invalid)).rejects.toThrow(InputError);
    });

    it("rejects bot creation when name exceeds 40 characters", async () => {
      const invalid: BotInput = {
        name: "A".repeat(41),
        handle: "longbot",
        title: "Bad",
        description: "",
        instructions: "",
        emoji: "❌",
        color: "#000",
        model: "mock",
        tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "ask",
        pinned: false,
      };

      await expect(createBot(invalid)).rejects.toThrow(InputError);
    });

    it("updates bot fields cleanly", async () => {
      const bot = await createBot({
        name: "Updatable Bot",
        handle: "updatable",
        title: "Initial Title",
        description: "Initial description",
        instructions: "Initial instructions",
        emoji: "📝",
        color: "#10b981",
        model: "MiniMaxAI/MiniMax-M3",
        tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true },
        connections: [],
        approval: "ask",
        pinned: false,
      });

      const updated = await updateBot(bot.id, {
        title: "Updated Senior Title",
        approval: "full",
        pinned: true,
      });

      expect(updated.title).toBe("Updated Senior Title");
      expect(updated.approval).toBe("full");
      expect(updated.pinned).toBe(true);

      const inDb = await store.getBot(bot.id);
      expect(inDb?.title).toBe("Updated Senior Title");
      expect(inDb?.approval).toBe("full");
    });

    it("deletes a bot and removes it from rooms", async () => {
      const bot = await createBot({
        name: "Delete Me",
        handle: "deleteme",
        title: "Ephemeral",
        description: "To be deleted",
        instructions: "",
        emoji: "🗑️",
        color: "#ef4444",
        model: "mock",
        tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false },
        connections: [],
        approval: "ask",
        pinned: false,
      });

      const room = await createRoom({
        name: "Room With Deletable Bot",
        topic: "Testing cleanup",
        emoji: "🚪",
        memberIds: [bot.id],
        leadId: bot.id,
        responder: "auto",
        pinned: false,
      });

      expect(room.memberIds).toContain(bot.id);

      await deleteBot(bot.id);

      // Verify bot deleted
      const fetchedBot = await store.getBot(bot.id);
      expect(fetchedBot).toBeNull();

      // Verify room memberIds no longer contains deleted bot
      const fetchedRoom = await store.getRoom(room.id);
      expect(fetchedRoom?.memberIds).not.toContain(bot.id);
    });
  });

  describe("Room Lifecycle & Validation", () => {
    it("creates a room and falls back leadId to first member if unset", async () => {
      const bots = await store.listBots();
      expect(bots.length).toBeGreaterThan(0);
      const memberIds = bots.slice(0, 2).map((b) => b.id);

      const roomInput: RoomInput = {
        name: "Collab Room",
        topic: "Working together",
        emoji: "👥",
        memberIds,
        leadId: null,
        responder: "everyone",
        pinned: true,
      };

      const created = await createRoom(roomInput);
      expect(created.id).toBeDefined();
      expect(created.name).toBe("Collab Room");
      expect(created.leadId).toBe(memberIds[0]); // fallback to first member
    });

    it("rejects room creation when name is empty", async () => {
      const invalid: RoomInput = {
        name: "   ",
        topic: "",
        emoji: "❌",
        memberIds: [],
        leadId: null,
        responder: "lead",
        pinned: false,
      };

      await expect(createRoom(invalid)).rejects.toThrow(InputError);
    });

    it("filters out non-existent bot IDs from room members", async () => {
      const bots = await store.listBots();
      const realId = bots[0].id;
      const fakeId = "non-existent-bot-99999";

      const room = await createRoom({
        name: "Filtered Room",
        topic: "Testing ID filter",
        emoji: "🔍",
        memberIds: [realId, fakeId],
        leadId: realId,
        responder: "auto",
        pinned: false,
      });

      expect(room.memberIds).toContain(realId);
      expect(room.memberIds).not.toContain(fakeId);
    });

    it("updates room metadata and responder mode", async () => {
      const bots = await store.listBots();
      const room = await createRoom({
        name: "Updateable Room",
        topic: "Initial topic",
        emoji: "📋",
        memberIds: [bots[0].id],
        leadId: bots[0].id,
        responder: "lead",
        pinned: false,
      });

      const updated = await updateRoom(room.id, {
        topic: "New improved topic",
        responder: "everyone",
        pinned: true,
      });

      expect(updated.topic).toBe("New improved topic");
      expect(updated.responder).toBe("everyone");
      expect(updated.pinned).toBe(true);
    });

    it("deletes a room record cleanly", async () => {
      const room = await createRoom({
        name: "Room to Delete",
        topic: "",
        emoji: "❌",
        memberIds: [],
        leadId: null,
        responder: "lead",
        pinned: false,
      });

      await deleteRoom(room.id);
      const fetched = await store.getRoom(room.id);
      expect(fetched).toBeNull();
    });
  });
});
