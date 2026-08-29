import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ghostCli } from "../src/cli/main.js";

class Sink {
  value = "";
  isTTY = false;
  write(chunk: string): void {
    this.value += chunk;
  }
}

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
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await ghostCli(["say", "hello", "--new", "-g", "casper"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.value).toBe("hello there\n");
    expect(stderr.value).toContain("⚙ bash: pwd");
    expect(fake.request()).toMatchObject({
      context: { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
      options: { sessionId: expect.stringMatching(/^cli-[a-z0-9]+-[a-f0-9]{8}$/) },
    });
  });

  it("emits every event as one JSON line", async () => {
    const fake = await fakeDaemon(successEvents);
    const stdout = new Sink();
    const code = await ghostCli(["say", "hello", "--new", "-g", "casper", "--json"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdout,
      stderr: new Sink(),
    });
    expect(code).toBe(0);
    expect(stdout.value.trim().split("\n").map((line) => JSON.parse(line))).toEqual(successEvents);
  });

  it("reads piped stdin", async () => {
    const fake = await fakeDaemon(successEvents);
    const code = await ghostCli(["say", "--new", "-g", "casper", "-q"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdout: new Sink(),
      stderr: new Sink(),
      stdin: "from stdin",
    });
    expect(code).toBe(0);
    expect(fake.request()).toMatchObject({ context: { messages: [{ content: [{ text: "from stdin" }] }] } });
  });

  it("prints only the joined final text in quiet mode", async () => {
    const fake = await fakeDaemon(successEvents);
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await ghostCli(["say", "hello", "--new", "-g", "casper", "-q"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.value).toBe("hello there\n");
    expect(stderr.value).toBe("");
  });

  it("returns one for an error event", async () => {
    const fake = await fakeDaemon([{ type: "start" }, { type: "error", reason: "model", errorMessage: "broken", usage: {} }]);
    const stderr = new Sink();
    const code = await ghostCli(["say", "hello", "--new", "-g", "casper"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdout: new Sink(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.value).toContain("ghost: broken");
  });

  it("keeps JSON error events machine-readable and reports the failure on stderr", async () => {
    const events = [{ type: "start" }, { type: "error", reason: "model", errorMessage: "broken", usage: {} }];
    const fake = await fakeDaemon(events);
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await ghostCli(["say", "hello", "--new", "-g", "casper", "--json"], {
      env: fake.env,
      home: "/tmp/ghost-cli-home",
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stdout.value.trim().split("\n").map((line) => JSON.parse(line))).toEqual(events);
    expect(stderr.value).toContain("ghost: broken");
  });
});
