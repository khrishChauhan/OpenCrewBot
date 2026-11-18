import { describe, it, expect } from "vitest";
import {
  db,
  getSetting,
  setSetting,
  saveBot,
  getBot,
  listBots,
  deleteBotRow,
  saveRoom,
  getRoom,
  listRooms,
  deleteRoomRow,
  saveMessage,
  listMessages,
  clearMessages,
  lastMessages,
  unreadCounts,
  markRead,
  conversationGeneration,
  bumpGeneration,
} from "@/lib/server/db";
import type { Bot, Room, ChatMessage } from "@/lib/shared/types";

describe("Database & Persistent Storage (db.ts)", () => {
  it("initializes SQLite client and tables successfully", async () => {
    const client = await db();
    expect(client).toBeDefined();
    // Verify tables exist
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bots', 'rooms', 'messages', 'settings', 'conversations')"
    );
    expect(tables.rows.length).toBe(5);
  });

  describe("Settings Key-Value Storage", () => {
    it("persists and retrieves arbitrary JSON settings", async () => {
      const key = "test-setting-key";
      const payload = { enabled: true, count: 42, tags: ["ai", "crew"] };
      await setSetting(key, payload);

      const retrieved = await getSetting<typeof payload>(key);
      expect(retrieved).toEqual(payload);
    });

    it("returns undefined for non-existent setting key", async () => {
      const nonExistent = await getSetting("missing-key-" + Date.now());
      expect(nonExistent).toBeUndefined();
    });
  });

  describe("Bot CRUD Operations", () => {
    const testBot: Bot = {
      id: "testbot1",
      name: "Test Bot",
      handle: "testbot",
      title: "Tester",
      description: "Automated test agent",
      instructions: "Follow test procedures.",
      emoji: "🤖",
      color: "#123456",
      model: "MiniMaxAI/MiniMax-M3",
      tools: {
        webSearch: false,
        memory: true,
        codeMode: false,
        browser: false,
        askUser: true,
      },
      connections: [],
      approval: "ask",
      pinned: false,
      createdAt: new Date().toISOString(),
    };

    it("saves and retrieves a bot record", async () => {
      await saveBot(testBot);
      const fetched = await getBot(testBot.id);
      expect(fetched).toEqual(testBot);
    });

    it("lists saved bots ordered by createdAt", async () => {
      const bots = await listBots();
      expect(bots.some((b) => b.id === testBot.id)).toBe(true);
    });

    it("deletes a bot record", async () => {
      await deleteBotRow(testBot.id);
      const fetched = await getBot(testBot.id);
      expect(fetched).toBeNull();
    });
  });

  describe("Room CRUD Operations", () => {
    const testRoom: Room = {
      id: "testroom1",
      name: "Test Room",
      topic: "Integration testing space",
      emoji: "🧪",
      memberIds: ["bot1", "bot2"],
      leadId: "bot1",
      responder: "auto",
      pinned: false,
      createdAt: new Date().toISOString(),
    };

    it("saves and retrieves a room record", async () => {
      await saveRoom(testRoom);
      const fetched = await getRoom(testRoom.id);
      expect(fetched).toEqual(testRoom);
    });

    it("lists rooms ordered by createdAt", async () => {
      const rooms = await listRooms();
      expect(rooms.some((r) => r.id === testRoom.id)).toBe(true);
    });

    it("deletes a room record", async () => {
      await deleteRoomRow(testRoom.id);
      const fetched = await getRoom(testRoom.id);
      expect(fetched).toBeNull();
    });
  });

  describe("Conversation Messages & State", () => {
    const convId = "dm:test-conv-1";
    const now = Date.now();
    const msg1: ChatMessage = {
      id: "msg-1",
      conversationId: convId,
      role: "user",
      createdAt: new Date(now - 20000).toISOString(),
      status: "done",
      parts: [{ kind: "text", text: "First message" }],
    };
    const msg2: ChatMessage = {
      id: "msg-2",
      conversationId: convId,
      role: "bot",
      botId: "testbot",
      createdAt: new Date(now - 10000).toISOString(),
      status: "done",
      parts: [{ kind: "text", text: "Response message" }],
    };

    it("saves and lists messages ordered by createdAt ascending", async () => {
      await saveMessage(msg1);
      await saveMessage(msg2);

      const msgs = await listMessages(convId);
      expect(msgs.length).toBe(2);
      expect(msgs[0].id).toBe("msg-1");
      expect(msgs[1].id).toBe("msg-2");
    });

    it("retrieves the last message for conversation preview", async () => {
      const lastMap = await lastMessages();
      expect(lastMap.get(convId)?.id).toBe("msg-2");
    });

    it("tracks unread message counts and marks as read", async () => {
      const unreadBefore = await unreadCounts();
      expect(unreadBefore.get(convId)).toBe(1); // msg2 is from bot

      await markRead(convId);
      const unreadAfter = await unreadCounts();
      expect(unreadAfter.get(convId) ?? 0).toBe(0);
    });

    it("manages conversation generations for clearing history", async () => {
      const gen0 = await conversationGeneration(convId);
      const gen1 = await bumpGeneration(convId);
      expect(gen1).toBe(gen0 + 1);

      await clearMessages(convId);
      const msgs = await listMessages(convId);
      expect(msgs.length).toBe(0);
    });
  });
});
