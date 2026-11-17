import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModel } from "../src/local-model.js";
import { SessionHost } from "../src/session-host.js";
import type { TurnEvent } from "../src/turn-events.js";
import { onlyHarnesses, fakeHarness, replies } from "./helpers/fake-harness.js";
import { makeTempGhosts, seedGhost, tempDir, type TempGhosts } from "./helpers/fixtures.js";

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> } };

/** An OpenAI-style chat server that streams the scripted replies in order and keeps each request. */
function fakeServer(script: Reply[]) {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.json() as (typeof requests)[number]);
      const reply = script.shift() ?? { text: "(no more replies)" };
      const delta = reply.call
        ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }
        : { content: reply.text };
      const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const model = {
    name: "gemma-test",
    acquire: async () => ({ url: `http://127.0.0.1:${server.port}`, key: "k" }),
    release: () => {},
    stop: async () => {},
  } as unknown as LocalModel;
  return { model, requests, close: () => server.stop(true) };
}

let temp: TempGhosts;
let closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers) close();
  closers = [];
  temp?.cleanup();
});

function host(script: Reply[], cloud = fakeHarness(replies("from the cloud"), "cloud")) {
  temp?.cleanup();
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper", character: "# Casper\n" });
  const server = fakeServer(script);
  closers.push(server.close);
  const sessions = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    ...onlyHarnesses(cloud),
    localModel: server.model,
  });
  return { sessions, server, cloud };
}

async function turn(sessions: SessionHost, prompt: string): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await sessions.runTurn("casper", { sessionId: "c1", prompt, emit: (event) => events.push(event) });
  return events;
}

const text = (events: readonly TurnEvent[]) => events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []).join("");

describe("the local model", () => {
  it("is listed and chosen like an agent, reads with its tools, and records what answered", async () => {
    const folder = tempDir();
    closers.push(folder.cleanup);
    writeFileSync(join(folder.path, "letter.txt"), "Dear Casper");
    const { sessions, server, cloud } = host([
      { call: { name: "list_folder", args: { folder: folder.path } } },
      { text: "There is one letter." },
    ]);
    expect((await sessions.listHarnesses("casper")).harnesses.map((row) => row.id)).toContain("local");
    await sessions.chooseHarness("casper", "c1", "local");
    const events = await turn(sessions, "What is in the folder?");

    expect(text(events)).toBe("There is one letter.");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", toolName: "list_folder" }));
    // The folder listing reached the model as the tool's result.
    expect(server.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("letter.txt") });
    expect(server.requests[0]?.messages[0]?.content).toContain("## Running locally");
    expect(cloud.calls()).toHaveLength(0);
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ harness: "local", model: "gemma-test", provider: "local" });
  });

  it("is never a fallback, and nothing else answers where it was chosen", async () => {
    const failing = fakeHarness([{ exit: 1, stderr: "not signed in" }], "cloud");
    const { sessions, server } = host([], failing);
    expect((await turn(sessions, "hi")).at(-1)).toMatchObject({ type: "error" });
    expect(server.requests).toHaveLength(0);

    const chosen = host([{ text: "local answer" }]);
    writeFileSync(join(temp.root, "casper", "settings.yml"), "harness: local\n");
    expect(text(await turn(chosen.sessions, "hi"))).toBe("local answer");
    expect(chosen.cloud.calls()).toHaveLength(0);
  });

  it("runs a proposed command only after the owner approves it", async () => {
    const folder = tempDir();
    closers.push(folder.cleanup);
    const target = join(folder.path, "made.txt");
    const { sessions, server } = host([
      { call: { name: "run_command", args: { command: `touch '${target}'`, reason: "You asked for it." } } },
      { text: "I asked to create it." },
      { text: "Done." },
    ]);
    await sessions.chooseHarness("casper", "c1", "local");
    await turn(sessions, "Make the file.");
    expect(existsSync(target)).toBe(false);
    expect((await sessions.listSessions("casper"))[0]?.question).toMatchObject({ options: ["Run it", "Don't run it"] });
    // After a proposal the model answers without tools.
    expect(server.requests[1]?.tools).toBeUndefined();

    const events = await turn(sessions, "Run it");
    expect(existsSync(target)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "run_command", isError: false }));
    expect(server.requests[2]?.messages.at(-1)?.content).toContain("<approved-command>");
    expect((await sessions.listSessions("casper"))[0]?.question).toBeNull();
  });

  it("does not run a proposed command the owner did not approve", async () => {
    const folder = tempDir();
    closers.push(folder.cleanup);
    const target = join(folder.path, "never.txt");
    const { sessions, server } = host([
      { call: { name: "run_command", args: { command: `touch '${target}'`, reason: "" } } },
      { text: "Asked." },
      { text: "Understood." },
    ]);
    await sessions.chooseHarness("casper", "c1", "local");
    await turn(sessions, "Make the file.");
    await turn(sessions, "No, leave it.");
    expect(existsSync(target)).toBe(false);
    expect(server.requests[2]?.messages.at(-1)?.content).toContain("<declined-command>");
  });
});
