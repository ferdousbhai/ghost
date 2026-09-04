/**
 * Local endpoint detection, against a real loopback HTTP server on an
 * ephemeral port. The runner list is injected, so no test ever probes a
 * well-known port and no test depends on what this machine happens to run.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatModelChoice,
  detectLocalModelProviders,
  withLocalProviders,
  type LocalRunner,
} from "../src/local-models.js";

interface MockEndpoint {
  port: number;
  /** Every path the endpoint was asked for. */
  requests: string[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** An endpoint whose `/v1/models` answers with `handle`. */
async function startEndpoint(
  handle: (response: ServerResponse) => void,
): Promise<MockEndpoint> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    handle(response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

function jsonEndpoint(body: unknown): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

function runner(port: number, overrides: Partial<LocalRunner> = {}): LocalRunner {
  return { provider: "local-ollama", label: "Ollama", port, ...overrides };
}

/** A port nothing listens on: bind one, then release it. */
async function refusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("detectLocalModelProviders", () => {
  it("turns a responding endpoint into a zero-cost provider of every model it lists", async () => {
    const endpoint = await startEndpoint(jsonEndpoint({
      object: "list",
      data: [
        { id: "qwen3:8b", context_length: 40_960 },
        { id: "llama3.2:3b" },
        { id: "qwen3:8b" },
        { id: 7 },
      ],
    }));

    const detected = await detectLocalModelProviders({ runners: [runner(endpoint.port)] });

    expect(endpoint.requests).toEqual(["/v1/models"]);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.provider).toBe("local-ollama");
    expect(detected[0]?.config).toMatchObject({
      name: "Ollama (local)",
      baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
      api: "openai-completions",
    });
    expect(detected[0]?.config.models).toEqual([
      expect.objectContaining({
        id: "qwen3:8b",
        contextWindow: 40_960,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      expect.objectContaining({
        id: "llama3.2:3b",
        contextWindow: 128_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
  });

  it("reports every answering runner, in preference order", async () => {
    const ollama = await startEndpoint(jsonEndpoint({ data: [{ id: "a" }] }));
    const vllm = await startEndpoint(jsonEndpoint({ data: [{ id: "b", max_model_len: 8_192 }] }));

    const detected = await detectLocalModelProviders({
      runners: [
        runner(ollama.port),
        runner(vllm.port, { provider: "local-vllm", label: "vLLM" }),
      ],
    });

    expect(detected.map((provider) => provider.provider)).toEqual(["local-ollama", "local-vllm"]);
    expect(detected[1]?.config.models?.[0]?.contextWindow).toBe(8_192);
  });

  it("finds nothing on a refused port, and does not wait for the timeout", async () => {
    const port = await refusedPort();
    const started = Date.now();

    await expect(detectLocalModelProviders({
      runners: [runner(port)],
      timeoutMs: 5_000,
    })).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("finds nothing when the endpoint never answers", async () => {
    const endpoint = await startEndpoint(() => {});

    await expect(detectLocalModelProviders({
      runners: [runner(endpoint.port)],
      timeoutMs: 25,
    })).resolves.toEqual([]);
  });

  it("finds nothing behind a malformed body, an error status, or an empty list", async () => {
    const malformed = await startEndpoint((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("<html>not json</html>");
    });
    const failing = await startEndpoint((response) => {
      response.writeHead(500).end("nope");
    });
    const empty = await startEndpoint(jsonEndpoint({ data: [] }));

    for (const endpoint of [malformed, failing, empty]) {
      await expect(detectLocalModelProviders({ runners: [runner(endpoint.port)] }))
        .resolves.toEqual([]);
    }
  });

  it("probes nothing when the daemon is offline", async () => {
    const endpoint = await startEndpoint(jsonEndpoint({ data: [{ id: "a" }] }));

    await expect(detectLocalModelProviders({ offline: true, runners: [runner(endpoint.port)] }))
      .resolves.toEqual([]);
    expect(endpoint.requests).toEqual([]);
  });
});

describe("detected providers as ghost model policy", () => {
  const detected = [
    { provider: "local-ollama", config: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "qwen3:8b" }] } },
    { provider: "local-vllm", config: { baseUrl: "http://127.0.0.1:2/v1", models: [{ id: "oss-20b" }] } },
  ];

  it("adds detected providers without displacing a configured one", () => {
    const configured = { providers: { "local-ollama": { baseUrl: "http://elsewhere/v1" } } };

    expect(withLocalProviders(configured, detected).providers).toEqual({
      "local-ollama": { baseUrl: "http://elsewhere/v1" },
      "local-vllm": detected[1]?.config,
    });
    expect(withLocalProviders({ providers: {} }, []).providers).toEqual({});
  });

  it("drives from the first model of the first detected endpoint when nothing is bound", () => {
    expect(chatModelChoice(null, detected)).toEqual({
      ref: { provider: "local-ollama", modelId: "qwen3:8b" },
      origin: "local",
    });
  });

  it("lets an explicit binding and a configured provider win, with no local origin", () => {
    const bound = {
      providers: {},
      roles: { chat_model: { provider: "openai-codex", modelId: "gpt-5.6-sol" } },
    };
    expect(chatModelChoice(bound, detected)).toEqual({
      ref: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    });

    const configured = { providers: { openrouter: { models: [{ id: "free-1" }] } } };
    expect(chatModelChoice(configured, detected)).toEqual({
      ref: { provider: "openrouter", modelId: "free-1" },
    });
  });

  it("changes nothing when no endpoint answered", () => {
    expect(chatModelChoice(null, [])).toEqual({ ref: null });
    expect(chatModelChoice({ providers: {} }, [])).toEqual({ ref: null });
  });
});
