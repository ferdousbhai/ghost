/**
 * One completion for an owner command hook: `SessionHost.complete` behind
 * `POST /api/ghosts/:name/complete`, and `ghostd hook-complete`, which asks
 * its own daemon for it.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookCompleteCommand, parseHookCompleteInput } from "../src/hook-complete.js";
import { parseHooksDocument } from "../src/hook-policy.js";
import { GhostHookRunner } from "../src/hooks.js";
import type { LocalModel } from "../src/local-model.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
import { fakeHarness, onlyHarnesses, replies, type FakeHarness } from "./helpers/fake-harness.js";
import { makeTempGhosts, seedGhost, startTestDaemon, type TempGhosts, type TestDaemon } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let daemon: TestDaemon | null = null;
const harnesses: FakeHarness[] = [];
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const harness of harnesses.splice(0)) harness.cleanup();
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

function harness(...args: Parameters<typeof fakeHarness>): FakeHarness {
  const created = fakeHarness(...args);
  harnesses.push(created);
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
    acquire: async () => {
      acquired += 1;
      return { url: `http://127.0.0.1:${server.port}`, key: "k" };
    },
    release: () => {},
    stop: async () => {},
  } as unknown as LocalModel;
  return { model, prompts, acquired: () => acquired };
}

function host(fakes: FakeHarness[], options: Partial<SessionHostOptions> = {}): { sessions: SessionHost; home: string } {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  const home = seedGhost(temp.root, { name: "casper" });
  const sessions = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    ...onlyHarnesses(...fakes),
    ...options,
  });
  return { sessions, home };
}

const signal = () => AbortSignal.timeout(10_000);

describe("SessionHost.complete", () => {
  it("returns the harness's trimmed text, run in a scratch directory it then removes", async () => {
    const fake = harness([{ events: [{ type: "text", block: "a", delta: "  APPROVE\n" }] }]);
    const { sessions } = host([fake]);

    await expect(sessions.complete("casper", "Review this.", signal())).resolves.toBe("APPROVE");
    const [call] = fake.calls();
    expect(call).toMatchObject({ prompt: "Review this.", resume: false, ghost: "casper", session: null });
    expect(call?.cwd.startsWith(join(tmpdir(), "ghost-hook-"))).toBe(true);
    expect(existsSync(call!.cwd)).toBe(false);
  });

  it("falls through a failing harness to the next one, and names every failure when none completes", async () => {
    const broken = harness([{ exit: 1, stderr: "not signed in" }, { exit: 1, stderr: "not signed in" }], "broken");
    const silent = harness([{ events: [] }], "silent");
    const working = harness([{ events: [{ type: "text", block: "a", delta: "done" }] }], "working");
    const { sessions } = host([broken, silent, working]);

    await expect(sessions.complete("casper", "Classify.", signal())).resolves.toBe("done");
    expect([broken, silent, working].map((fake) => fake.calls().length)).toEqual([1, 1, 1]);
  });

  it("names every failure when no harness completes, and refuses an empty prompt", async () => {
    const broken = harness([{ exit: 1, stderr: "not signed in" }], "broken");
    const refused = harness([{ events: [{ type: "error", message: "usage limit reached" }] }], "refused");
    const { sessions } = host([broken, refused]);

    await expect(sessions.complete("casper", "   ", signal())).rejects.toThrow(/non-empty/u);
    await expect(sessions.complete("casper", "Classify.", signal()))
      .rejects.toThrow(/broken: not signed in.*refused: usage limit reached/u);
  });

  it("reports an exit by its stderr tail or status and rests the harness, as a delegated task does", async () => {
    const noisy = harness([{ exit: 1, stderr: "warming up\nnot signed in\nrun login" }], "noisy");
    const quiet = harness([{ exit: 3 }], "quiet");
    const killed = harness([{ kill: "SIGKILL" }], "killed");
    const { sessions } = host([noisy, quiet, killed]);

    await expect(sessions.complete("casper", "Classify.", signal())).rejects.toThrow(
      "noisy: warming up\nnot signed in\nrun login; quiet: quiet exited with status 3.; killed: killed exited with signal SIGKILL.",
    );
    const resting = (await sessions.listHarnesses("casper")).harnesses.filter((row) => row.resting).map((row) => row.id);
    expect(resting.sort()).toEqual(["killed", "noisy", "quiet"]);
  });

  it("completes on the daemon's own local model, as a turn would, never falling through to a cloud harness", async () => {
    const cloud = harness([{ events: [{ type: "text", block: "a", delta: "from the cloud" }] }], "cloud");
    const local = localModel(" APPROVE ");
    const { sessions, home } = host([cloud], { localModel: local.model });

    await expect(sessions.complete("casper", "Review this.", signal())).resolves.toBe("APPROVE");
    expect(local.prompts).toEqual([[{ role: "user", content: "Review this." }]]);
    expect(local.acquired()).toBe(1);
    expect(cloud.calls()).toEqual([]);

    // A ghost that prefers a cloud harness keeps it.
    writeFileSync(join(home, "settings.yml"), "harness: cloud\n");
    await expect(sessions.complete("casper", "Review this.", signal())).resolves.toBe("from the cloud");
    expect(local.prompts).toHaveLength(1);
  });

  it("refuses a ghost that prefers the local model when none is configured", async () => {
    const cloud = harness([{ events: [{ type: "text", block: "a", delta: "from the cloud" }] }], "cloud");
    const { sessions, home } = host([cloud]);
    writeFileSync(join(home, "settings.yml"), "harness: local\n");

    await expect(sessions.complete("casper", "Review this.", signal())).rejects.toThrow(/none is configured/u);
    expect(cloud.calls()).toEqual([]);
  });

  it("answers a session_stop hook while the turn awaiting it holds its admission", async () => {
    let sessions: SessionHost | null = null;
    const reviews: string[] = [];
    const hooks = new GhostHookRunner({
      commands: parseHooksDocument({ hooks: { session_stop: [{ hooks: [{ type: "command", command: "review" }] }] } }, "test"),
      commandRunner: async () => {
        reviews.push(await sessions!.complete("casper", "Is the turn done?", signal()));
        return { exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false, overflowed: false, executionFailed: false };
      },
    });
    const fake = harness(replies("the answer", "APPROVE"));
    ({ sessions } = host([fake], { hooks }));

    await sessions.runTurn("casper", { sessionId: "c1", prompt: "work", emit: () => {} });
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
    expect(daemon.harness.calls()).toMatchObject([{ prompt: "Review this.", ghost: "casper", session: null }]);
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
    host.complete = (ghost, prompt, signal) => (outcome = complete(ghost, prompt, signal));
    const hang = new AbortController();
    const through = ((input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal: hang.signal })) as typeof fetch;

    const asked = run(JSON.stringify({ ghost_home: join(daemon.temp.root, "casper"), prompt: "Review this." }), daemon.env, through);
    await vi.waitFor(() => expect(daemon?.harness.calls()).toHaveLength(1));
    hang.abort();

    // The held harness is killed rather than left to answer: the gate never opens.
    await expect(outcome).rejects.toThrow(/cancelled/u);
    expect((await asked).code).toBe(1);
    expect(existsSync(daemon.harness.calls()[0]!.cwd)).toBe(false);
  });

  it("rejects a non-ghost home, a relative path, and an empty prompt before asking", async () => {
    daemon = await startTestDaemon();
    const notHome = mkdtempSync(join(tmpdir(), "ghost-not-home-"));
    dirs.push(notHome);
    const home = join(daemon.temp.root, "casper");

    expect((await run(JSON.stringify({ ghost_home: notHome, prompt: "x" }), daemon.env)).stderr).toMatch(/not a Ghost home/u);
    expect((await run(JSON.stringify({ ghost_home: "ghosts/casper", prompt: "x" }), daemon.env)).stderr).toMatch(/absolute path/u);
    expect((await run(JSON.stringify({ ghost_home: home, prompt: "   " }), daemon.env)).stderr).toMatch(/non-empty/u);
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
  it("takes string ghost_home and prompt from a JSON object and refuses anything else", () => {
    expect(parseHookCompleteInput('{"ghost_home":"/g/casper","prompt":"hi","extra":1}'))
      .toEqual({ ghost_home: "/g/casper", prompt: "hi" });
    expect(() => parseHookCompleteInput("not json")).toThrow(/not valid JSON/u);
    expect(() => parseHookCompleteInput("[]")).toThrow(/JSON object/u);
    expect(() => parseHookCompleteInput('{"ghost_home":"/g","prompt":7}')).toThrow(/string ghost_home and prompt/u);
  });
});
