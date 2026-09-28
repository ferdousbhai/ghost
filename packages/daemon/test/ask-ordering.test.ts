import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { AskBroker } from "@ghost/runtime/ask-broker";
import { createAskTool, isAskToolInput } from "@ghost/runtime/ask-tool";

it("Pi waits for each local Ghost question before executing later calls in the same batch", async () => {
  const broker = new AskBroker();
  const tool = createAskTool({ broker, timeoutMs: () => 0 });
  const seen: string[] = [];
  const model: Model<"openai-completions"> = {
    id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture",
    baseUrl: "https://blocked.invalid", input: ["text"], reasoning: false,
    contextWindow: 32768, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const question = (text: string) => ({ questions: [{ question: text, header: "Choice", multiSelect: false,
    options: [{ label: "Yes", description: "Proceed" }, { label: "No", description: "Wait" }] }] });
  const calls = [
    { type: "toolCall" as const, id: "before", name: "record", arguments: { name: "before" } },
    { type: "toolCall" as const, id: "ask-1", name: "ask", arguments: question("First?") },
    { type: "toolCall" as const, id: "middle", name: "record", arguments: { name: "middle" } },
    { type: "toolCall" as const, id: "ask-2", name: "ask", arguments: question("Second?") },
    { type: "toolCall" as const, id: "after", name: "record", arguments: { name: "after" } },
  ];
  const agent = new Agent({
    initialState: { model, tools: [
      { ...tool, execute: (id, params, signal, update) => {
        if (!isAskToolInput(params)) throw new Error("Invalid question fixture");
        return tool.execute(id, params, signal, update, {} as never);
      } },
      { name: "record", label: "record", description: "Inert test action", parameters: Type.Object({ name: Type.String() }),
        async execute(_id, params) { const name = (params as { name: string }).name; seen.push(name); return { content: [{ type: "text", text: name }], details: {} }; } },
    ] },
    toolExecution: "parallel",
    shouldStopAfterTurn: () => true,
    streamFn() {
      const message: AssistantMessage = { role: "assistant", content: calls, stopReason: "toolUse", api: model.api,
        provider: model.provider, model: model.id, timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  });
  const work = agent.prompt("Ask twice before finishing.");
  try {
    await vi.waitFor(() => expect(broker.pending?.questions[0]?.question).toBe("First?"));
    expect(seen).toEqual(["before"]);
    const firstId = broker.pending!.id;
    broker.answer(firstId, { kind: "submit", results: [{ id: "question-1", selectedOptions: ["Yes"] }] });
    await vi.waitFor(() => expect(broker.pending?.questions[0]?.question).toBe("Second?"));
    expect(broker.pending!.id).not.toBe(firstId);
    expect(seen).toEqual(["before", "middle"]);
    broker.answer(broker.pending!.id, { kind: "submit", results: [{ id: "question-1", selectedOptions: ["No"] }] });
    await work;
    expect(seen).toEqual(["before", "middle", "after"]);
    expect(agent.state.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId))
      .toEqual(calls.map((call) => call.id));
  } finally {
    agent.abort();
    broker.close();
    await work;
  }
});
