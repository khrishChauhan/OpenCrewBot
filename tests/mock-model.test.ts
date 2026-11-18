import { describe, it, expect } from "vitest";
import { createMockModel } from "@/lib/server/mock-model";

interface StreamChunk {
  type: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
  finishReason?: string;
}

interface StreamResult {
  stream: ReadableStream<StreamChunk>;
}

interface MockInvokable {
  doStream(options: { prompt: unknown[]; tools?: Array<{ name: string }> }): Promise<StreamResult>;
}

// Helper to consume a ReadableStream returned by doStream
async function collectStream(stream: ReadableStream<StreamChunk>): Promise<StreamChunk[]> {
  const reader = stream.getReader();
  const chunks: StreamChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return chunks;
}

describe("Mock Model Stand-in (mock-model.ts)", () => {
  const botName = "MockTester";
  const model = createMockModel(botName) as unknown as MockInvokable;

  it("streams standard introduction text for generic input", async () => {
    const res = await model.doStream({
      prompt: [{ role: "user", content: "Hello there" }],
      tools: [],
    });

    const chunks = await collectStream(res.stream);
    const textDeltas = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta ?? "").join("");

    expect(textDeltas).toContain(`Hi, I'm **${botName}**`);
    expect(textDeltas).toContain('You said: "Hello there"');
  });

  it("triggers memory_add tool call when prompt contains 'remember that'", async () => {
    const res = await model.doStream({
      prompt: [{ role: "user", content: "remember that I prefer TypeScript" }],
      tools: [{ name: "memory_add" }],
    });

    const chunks = await collectStream(res.stream);
    const toolCall = chunks.find((c) => c.type === "tool-call");

    expect(toolCall).toBeDefined();
    expect(toolCall?.toolName).toBe("memory_add");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ note: "I prefer TypeScript" });
  });

  it("triggers ask_user tool call when prompt contains 'ask me'", async () => {
    const res = await model.doStream({
      prompt: [{ role: "user", content: "ask me a question" }],
      tools: [{ name: "ask_user" }],
    });

    const chunks = await collectStream(res.stream);
    const toolCall = chunks.find((c) => c.type === "tool-call");

    expect(toolCall).toBeDefined();
    expect(toolCall?.toolName).toBe("ask_user");
    const input = JSON.parse(toolCall?.input ?? "{}");
    expect(input.question).toContain("short answers or detailed");
  });

  it("triggers browser_goto when prompt contains 'open http...'", async () => {
    const res = await model.doStream({
      prompt: [{ role: "user", content: "open https://example.com/docs" }],
      tools: [{ name: "browser_goto" }],
    });

    const chunks = await collectStream(res.stream);
    const toolCall = chunks.find((c) => c.type === "tool-call");

    expect(toolCall).toBeDefined();
    expect(toolCall?.toolName).toBe("browser_goto");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ url: "https://example.com/docs" });
  });

  it("triggers web_search when prompt contains 'search for'", async () => {
    const res = await model.doStream({
      prompt: [{ role: "user", content: "search for mastra documentation" }],
      tools: [{ name: "web_search" }],
    });

    const chunks = await collectStream(res.stream);
    const toolCall = chunks.find((c) => c.type === "tool-call");

    expect(toolCall).toBeDefined();
    expect(toolCall?.toolName).toBe("web_search");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ query: "mastra documentation", maxResults: 3 });
  });

  it("formats completion output when receiving tool results", async () => {
    const res = await model.doStream({
      prompt: [
        { role: "user", content: "remember something" },
        {
          role: "tool",
          content: [{ output: { value: "Saved to memory" } }],
        },
      ],
      tools: [],
    });

    const chunks = await collectStream(res.stream);
    const textDeltas = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta ?? "").join("");

    expect(textDeltas).toContain("Done. The tool returned: Saved to memory");
    expect(textDeltas).toContain("Mock model. The tool really ran.");
  });
});
