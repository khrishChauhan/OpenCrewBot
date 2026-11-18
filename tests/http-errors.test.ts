import { describe, it, expect } from "vitest";
import { handle, body, conversationParam } from "@/lib/server/http";
import { InputError } from "@/lib/server/errors";

describe("API Error Handling & Route Utilities (http.ts)", () => {
  describe("handle() route wrapper", () => {
    it("returns HTTP 200 with result payload on success", async () => {
      const response = await handle(async () => ({ success: true, count: 5 }));
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json).toEqual({ success: true, count: 5 });
    });

    it("returns HTTP 200 with { ok: true } when handler returns undefined", async () => {
      const response = await handle(async () => undefined);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json).toEqual({ ok: true });
    });

    it("returns direct Response when handler returns a Response object", async () => {
      const customResponse = new Response("Custom output", { status: 201 });
      const response = await handle(async () => customResponse);

      expect(response.status).toBe(201);
      const text = await response.text();
      expect(text).toBe("Custom output");
    });

    it("catches InputError and converts to HTTP 400 Bad Request", async () => {
      const response = await handle(async () => {
        throw new InputError("Invalid bot name supplied.");
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json).toEqual({ error: "Invalid bot name supplied." });
    });

    it("catches standard Error and converts to HTTP 500 Internal Server Error", async () => {
      const response = await handle(async () => {
        throw new Error("Database disk connection lost.");
      });

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json).toEqual({ error: "Database disk connection lost." });
    });
  });

  describe("body() JSON body extractor", () => {
    it("parses valid JSON from request", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ name: "Atlas", action: "plan" }),
        headers: { "Content-Type": "application/json" },
      });

      const parsed = await body<{ name: string; action: string }>(req);
      expect(parsed).toEqual({ name: "Atlas", action: "plan" });
    });

    it("throws InputError with 'Expected a JSON body.' when body is malformed", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: "malformed-not-json",
        headers: { "Content-Type": "application/json" },
      });

      await expect(body(req)).rejects.toThrow(InputError);
      await expect(body(req)).rejects.toThrow("Expected a JSON body.");
    });
  });

  describe("conversationParam() URL decoder", () => {
    it("decodes URL-encoded conversation IDs cleanly", () => {
      expect(conversationParam("dm%3Aac884c01")).toBe("dm:ac884c01");
      expect(conversationParam("room%3Astudio-1")).toBe("room:studio-1");
    });

    it("passes unencoded IDs untouched", () => {
      expect(conversationParam("dm:scout")).toBe("dm:scout");
    });
  });
});
