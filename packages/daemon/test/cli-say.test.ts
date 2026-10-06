import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function fakeDaemon(events: unknown[]): Promise<{
  env: NodeJS.ProcessEnv;
  request: () => unknown;
}> {
  let posted: unknown;
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/ghosts") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ name: "casper", dir: "/tmp/casper", createdAt: new Date().toISOString() }]));
      return;
    }
    if (request.method === "GET" && request.url === "/api/ghosts/casper/sessions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessions: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { env: { GHOSTD_PORT: String(port) }, request: () => posted };
}

const successEvents = [
  { type: "start" },
  { type: "text_delta", contentIndex: 0, delta: "hel" },
  { type: "text_delta", contentIndex: 0, delta: "lo " },
  { type: "text_delta", contentIndex: 0, delta: "there" },
  { type: "tool_execution_start", id: "1", toolName: "bash", arguments: { command: "pwd\nwhoami" }, cwd: "/tmp" },
  { type: "tool_execution_end", id: "1", toolName: "bash", isError: false },
  { type: "done", reason: "stop", usage: {} },
];

describe("ghost say", () => {
  it("streams text, reports tool activity, and sends a new raw cli id", async () => {
    const fake = await fakeDaemon(successEvents);
    const result = await runCli(["say", "hello", "--new", "-g", "casper"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello there\n");
    expect(result.stderr).toContain("⚙ bash: pwd");
    expect(fake.request()).toMatchObject({
      prompt: "hello",
      sessionId: expect.stringMatching(/^cli-[a-z0-9]+-[a-f0-9]{8}$/),
    });
  });

  it("prints an owner !command's output, the turn's whole answer", async () => {
    const fake = await fakeDaemon([
      { type: "start" },
      { type: "tool_execution_start", id: "bash-1", toolName: "bash", arguments: { command: "ls" }, cwd: "/home/owner" },
      { type: "tool_execution_update", id: "bash-1", toolName: "bash", summary: "a" },
      { type: "tool_execution_end", id: "bash-1", toolName: "bash", isError: true, summary: "a\nb\nls: c: No such file" },
      { type: "done", reason: "stop" },
    ]);
    const result = await runCli(["say", "!ls", "--new", "-g", "casper"], { env: fake.env, home: "/tmp/ghost-cli-home" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("a\nb\nls: c: No such file\n");
    expect(result.stderr).not.toContain("✗");
    const quiet = await runCli(["say", "!ls", "--new", "-g", "casper", "-q"], { env: fake.env, home: "/tmp/ghost-cli-home" });
    expect(quiet.stdout).toBe("a\nb\nls: c: No such file\n");
  });

  it("starts each text block on its own paragraph", async () => {
    const fake = await fakeDaemon([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "I'll check the log." },
      { type: "tool_execution_start", id: "1", toolName: "bash", arguments: { command: "tail log" } },
      { type: "tool_execution_end", id: "1", toolName: "bash", isError: false },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: "It failed at 3am." },
      { type: "done", reason: "stop" },
    ]);
    const result = await runCli(["say", "why", "--new", "-g", "casper", "-q"], { env: fake.env, home: "/tmp/ghost-cli-home" });
    expect(result.stdout).toBe("I'll check the log.\n\nIt failed at 3am.\n");
  });

  it("emits every event as one JSON line", async () => {
    const fake = await fakeDaemon(successEvents);
    const result = await runCli(["say", "hello", "--new", "-g", "casper", "--json"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual(successEvents);
  });

  it("reads piped stdin", async () => {
    const fake = await fakeDaemon(successEvents);
    const result = await runCli(["say", "--new", "-g", "casper", "-q"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdin: "from stdin",
    });
    expect(result.code).toBe(0);
    expect(fake.request()).toMatchObject({ prompt: "from stdin" });
  });

  it("returns one for an error event", async () => {
    const fake = await fakeDaemon([{ type: "start" }, { type: "error", reason: "model", errorMessage: "broken", usage: {} }]);
    const result = await runCli(["say", "hello", "--new", "-g", "casper"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ghost: broken");
  });

  it("keeps JSON error events machine-readable and reports the failure on stderr", async () => {
    const events = [{ type: "start" }, { type: "error", reason: "model", errorMessage: "broken", usage: {} }];
    const fake = await fakeDaemon(events);
    const result = await runCli(["say", "hello", "--new", "-g", "casper", "--json"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
    });
    expect(result.code).toBe(1);
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual(events);
    expect(result.stderr).toContain("ghost: broken");
  });
});
