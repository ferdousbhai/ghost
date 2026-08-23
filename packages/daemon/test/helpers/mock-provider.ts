/**
 * A scripted, OpenAI-chat-completions-compatible SSE provider.
 *
 * Ported from the spike's `pi-spike/mock-ghost-provider.mjs`, which exists
 * because the older canned-text mock could never exercise a tool loop. Tests
 * NEVER call a real model: this server binds an ephemeral loopback port,
 * plays a fixed script of steps, and records what the agent actually sent so
 * assertions can be made against ground truth (the real system prompt, the
 * real tool schemas) rather than against intent.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "error"; status: number; body: string };

export interface CapturedRequest {
  system: string;
  messages: unknown[];
  toolNames: string[];
  /** The model id the agent asked to run on (OpenAI `model` field). */
  model: string;
}

export interface MockProvider {
  url: string;
  modelId: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

export interface MockProviderOptions {
  /**
   * One step per provider round-trip *within a conversation*. The step is
   * chosen by counting the assistant messages the agent sent back, not by a
   * server-side counter, so two ghosts talking to the same mock at the same
   * time each walk the script independently. The last step repeats once the
   * script is exhausted.
   */
  script: MockStep[];
  modelId?: string;
  /** Milliseconds between streamed chunks. Keep tiny; tests are serial. */
  chunkDelayMs?: number;
}

/** Where in the script this conversation is: one step per assistant turn. */
function stepIndexFor(messages: Array<{ role?: string }>): number {
  return messages.filter((message) => message.role === "assistant").length;
}

function sse(response: { write(chunk: string): void }, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startMockProvider(
  options: MockProviderOptions,
): Promise<MockProvider> {
  const modelId = options.modelId ?? "mock-ghost-1";
  const delay = options.chunkDelayMs ?? 0;
  const requests: CapturedRequest[] = [];
  let step = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
        model?: string;
        stream?: boolean;
      };
      const system = body.messages?.find((message) => message.role === "system");
      requests.push({
        system: typeof system?.content === "string"
          ? system.content
          : JSON.stringify(system?.content ?? ""),
        messages: body.messages ?? [],
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? "?"),
        model: typeof body.model === "string" ? body.model : "",
      });

      const turn = stepIndexFor(body.messages ?? []);
      const action = options.script[Math.min(turn, options.script.length - 1)];
      step += 1;
      if (!action) {
        response.writeHead(500).end("mock provider has no script step");
        return;
      }
      if (action.kind === "error") {
        response.writeHead(action.status, { "content-type": "application/json" });
        response.end(action.body);
        return;
      }

      const id = `chatcmpl-mock-${step}`;
      const base = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        // Echo the requested model so a switch is observable and never mismatches.
        model: (typeof body.model === "string" && body.model) || modelId,
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      if (action.kind === "text") {
        sse(response, {
          ...base,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        for (const word of action.text.split(" ")) {
          sse(response, {
            ...base,
            choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
          });
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
        sse(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        const callId = `call_${step}`;
        sse(response, {
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: callId,
                type: "function",
                function: { name: action.name, arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        });
        const argJson = JSON.stringify(action.args);
        for (let offset = 0; offset < argJson.length; offset += 16) {
          sse(response, {
            ...base,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: argJson.slice(offset, offset + 16) },
                }],
              },
              finish_reason: null,
            }],
          });
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
        sse(response, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      }
      sse(response, {
        ...base,
        choices: [],
        usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    })();
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    modelId,
    requests,
    close: () => {
      if (!server.listening) return Promise.resolve();
      return new Promise<void>((resolvePromise, rejectPromise) => {
        server.closeAllConnections();
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
            resolvePromise();
            return;
          }
          rejectPromise(error);
        });
      });
    },
  };
}
