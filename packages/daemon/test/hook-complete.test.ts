/**
 * One completion for an owner command hook: `SessionHost.complete` behind
 * `POST /api/complete`, and `ghostd hook-complete`, which asks
 * its own daemon for it.
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookCompleteCommand, parseHookCompleteInput } from "../src/hook-complete.js";
import { parseHooksDocument } from "../src/hook-policy.js";
import { GhostHookRunner } from "../src/hooks.js";
import type { LocalModel } from "../src/local-model.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
import { fakeAnswerer, answeredBy, replies, type FakeAnswerer } from "./helpers/fake-answerer.js";
import { makeTempGhosts, seedGhost, startTestDaemon, type TempGhosts, type TestDaemon } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let daemon: TestDaemon | null = null;
const fakes: FakeAnswerer[] = [];
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const fake of fakes.splice(0)) fake.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (daemon) {
    await daemon.listening.close();
    daemon.harness.cleanup();
    daemon.temp.cleanup();
    daemon = null;
  }
  temp?.cleanup();
  temp = null;
});

function harness(...args: Parameters<typeof fakeAnswerer>): FakeAnswerer {
  const created = fakeAnswerer(...args);
  fakes.push(created);
  return created;
}

/** A local model whose chat server answers every request with `reply`, keeping each prompt. */
function localModel(reply: string) {
  const prompts: unknown[] = [];
  let acquired = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      prompts.push(((await request.json()) as { messages: unknown[] }).messages);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
    },
  });
  closers.push(() => server.stop(true));
  const model = {
    name: "gemma-test",
    config: { reasoningEffort: "low" },
    acquire: async () => {
      acquired += 1;
      return { url: `http://127.0.0.1:${server.port}`, key: "k" };
    },
    release: () => {},
    stop: async () => {},
  } as unknown as LocalModel;
  return { model, prompts, acquired: () => acquired };
}

function host(fakes: [FakeAnswerer] | [], options: Partial<SessionHostOptions> = {}): { sessions: SessionHost; home: string } {
  temp = makeTempGhosts();
  const home = seedGhost(temp.root, { name: "casper" });
  const sessions = new SessionHost({
    ghost: temp.ghost,
    ownerHome: temp.ownerHome,
    ...(fakes[0] ? answeredBy(fakes[0]) : {}),
    ...options,
  });
  return { sessions, home };
}

const signal = () => AbortSignal.timeout(10_000);

describe("SessionHost.complete", () => {
  it("returns the trimmed text, and refuses an empty prompt or an empty answer", async () => {
    const fake = harness([{ events: [{ type: "text", block: "a", delta: "  APPROVE\n" }] }, { events: [] }]);
    const { sessions } = host([fake]);

    await expect(sessions.complete("   ", signal())).rejects.toThrow(/non-empty/u);
    await expect(sessions.complete("Review this.", signal())).resolves.toBe("APPROVE");
    expect(fake.calls().map((call) => call.prompt)).toEqual(["Review this."]);
    await expect(sessions.complete("Classify.", signal())).rejects.toMatchObject({ code: "completion_failed" });
  });

  it("completes on the daemon's own local model, with no persona or tools", async () => {
    const local = localModel(" APPROVE ");
    const { sessions } = host([], { localModel: local.model });

    await expect(sessions.complete("Review this.", signal())).resolves.toBe("APPROVE");
    expect(local.prompts).toEqual([[{ role: "user", content: "Review this." }]]);
    expect(local.acquired()).toBe(1);
  });

  it("answers a session_stop hook while the turn awaiting it holds its admission", async () => {
    let sessions: SessionHost | null = null;
    const reviews: string[] = [];
    const hooks = new GhostHookRunner({
      commands: parseHooksDocument({ hooks: { session_stop: [{ hooks: [{ type: "command", command: "review" }] }] } }, "test"),
      commandRunner: async () => {
        reviews.push(await sessions!.complete("Is the turn done?", signal()));
        return { exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false, overflowed: false, executionFailed: false };
      },
    });
    const fake = harness(replies("the answer", "APPROVE"));
    ({ sessions } = host([fake], { hooks }));

    await sessions.runTurn({ sessionId: "c1", prompt: "work", emit: () => {} });
    expect(reviews).toEqual(["APPROVE"]);
  });
});

describe("ghostd hook-complete", () => {
  async function run(stdin: string, env: NodeJS.ProcessEnv, through: typeof fetch = fetch): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await hookCompleteCommand([], {
      env,
      fetch: through,
      home: daemon?.temp.ownerHome ?? tmpdir(),
      stdin,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    });
    return { code, stdout, stderr };
  }

  it("asks its own daemon and prints the completion", async () => {
    daemon = await startTestDaemon({ turns: replies("APPROVE") });
    const home = join(daemon.temp.root, "casper");

    await expect(run(JSON.stringify({ ghost_home: home, prompt: "Review this." }), daemon.env))
      .resolves.toEqual({ code: 0, stdout: `${JSON.stringify({ text: "APPROVE" })}\n`, stderr: "" });
    expect(daemon.harness.calls()).toMatchObject([{ prompt: "Review this." }]);
  });

  it("sets no deadline of its own, so the hook's timeout bounds the call", async () => {
    daemon = await startTestDaemon({ turns: replies("APPROVE") });
    const inits: RequestInit[] = [];
    const through = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return fetch(input, init);
    }) as typeof fetch;
    const home = join(daemon.temp.root, "casper");

    expect((await run(JSON.stringify({ ghost_home: home, prompt: "Review this." }), daemon.env, through)).code).toBe(0);
    // Bun's own 5-minute idle timer is off too; a hook may allow up to 600 s.
    expect(inits).toMatchObject([{ timeout: false }]);
  });

  it("stops the completion when its request closes, as when the hook's timeout kills it", async () => {
    daemon = await startTestDaemon();
    const gate = daemon.harness.gate("held");
    daemon.harness.setTurns([{ gate: gate.path, events: [{ type: "text", block: "a", delta: "too late" }] }]);
    const host = daemon.host;
    const complete = host.complete.bind(host);
    let outcome: Promise<string> | null = null;
    host.complete = (prompt, signal) => (outcome = complete(prompt, signal));
    const hang = new AbortController();
    const through = ((input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal: hang.signal })) as typeof fetch;

    const asked = run(JSON.stringify({ ghost_home: join(daemon.temp.root, "casper"), prompt: "Review this." }), daemon.env, through);
    await vi.waitFor(() => expect(daemon?.harness.calls()).toHaveLength(1));
    hang.abort();

    // The held harness is killed rather than left to answer: the gate never opens.
    await expect(outcome).rejects.toThrow(/stopped/u);
    expect((await asked).code).toBe(1);
    expect(existsSync(daemon.harness.calls()[0]!.cwd)).toBe(false);
  });

  it("rejects an empty prompt before asking", async () => {
    daemon = await startTestDaemon();
    expect((await run(JSON.stringify({ prompt: "   " }), daemon.env)).stderr).toMatch(/non-empty/u);
    expect(daemon.harness.calls()).toEqual([]);
  });

  it("says so clearly when its daemon is not running", async () => {
    daemon = await startTestDaemon();
    const env = { ...daemon.env };
    const port = daemon.listening.port;
    await daemon.listening.close();
    const result = await run(JSON.stringify({ ghost_home: join(daemon.temp.root, "casper"), prompt: "x" }), env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`cannot reach ghostd.* at http://127\\.0\\.0\\.1:${port}; is it running\\?`, "u"));
    daemon.listening.close = async () => {};
  });
});

describe("parseHookCompleteInput", () => {
  it("takes a string prompt from a JSON object and refuses anything else", () => {
    expect(parseHookCompleteInput('{"ghost_home":"/g/casper","prompt":"hi","extra":1}'))
      .toEqual({ prompt: "hi" });
    expect(() => parseHookCompleteInput("not json")).toThrow(/not valid JSON/u);
    expect(() => parseHookCompleteInput("[]")).toThrow(/JSON object/u);
    expect(() => parseHookCompleteInput('{"ghost_home":"/g","prompt":7}')).toThrow(/string prompt/u);
  });
});
