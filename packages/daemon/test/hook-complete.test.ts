/**
 * `ghostd hook-complete`: one completion for an owner command hook, run
 * on the first harness that answers, in a scratch directory.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeForHook, parseHookCompleteInput } from "../src/hook-complete.js";
import type { LocalModel } from "../src/local-model.js";
import { fakeHarness, type FakeHarness } from "./helpers/fake-harness.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
const harnesses: FakeHarness[] = [];
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  temp?.cleanup();
  temp = null;
});

function harness(...args: Parameters<typeof fakeHarness>): FakeHarness {
  const created = fakeHarness(...args);
  harnesses.push(created);
  return created;
}

function seams(...fakes: FakeHarness[]) {
  const rows = new Map(fakes.map((fake) => [fake.id, fake.row]));
  return {
    harnesses: async () => fakes.map((fake) => fake.id),
    rows: (id: string) => rows.get(id) ?? null,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    local: null as LocalModel | null,
  };
}

/** A local model whose chat server answers every request with `reply`, keeping each prompt. */
function localModel(reply: string) {
  const prompts: unknown[] = [];
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
    acquire: async () => ({ url: `http://127.0.0.1:${server.port}`, key: "k" }),
    release: () => {},
    stop: async () => {},
  } as unknown as LocalModel;
  return { model, prompts };
}

function ghostHome(): string {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  return seedGhost(temp.root, { name: "casper" });
}

describe("completeForHook", () => {
  it("returns the harness's trimmed text, run in a scratch directory it then removes", async () => {
    const fake = harness([{ events: [{ type: "text", block: "a", delta: "  APPROVE\n" }] }]);
    const home = ghostHome();

    await expect(completeForHook({ ghost_home: home, prompt: "Review this." }, seams(fake))).resolves.toBe("APPROVE");
    const [call] = fake.calls();
    expect(call).toMatchObject({ prompt: "Review this.", resume: false, mcp: [], ghost: null, session: null });
    expect(call?.cwd.startsWith(join(tmpdir(), "ghost-hook-"))).toBe(true);
    expect(existsSync(call!.cwd)).toBe(false);
  });

  it("falls through a failing harness to the next one", async () => {
    const broken = harness([{ exit: 1, stderr: "not signed in" }], "broken");
    const silent = harness([{ events: [] }], "silent");
    const working = harness([{ events: [{ type: "text", block: "a", delta: "done" }] }], "working");
    const home = ghostHome();

    await expect(completeForHook({ ghost_home: home, prompt: "Classify." }, seams(broken, silent, working)))
      .resolves.toBe("done");
    expect([broken, silent, working].map((fake) => fake.calls().length)).toEqual([1, 1, 1]);
  });

  it("names every failure when no harness completes", async () => {
    const broken = harness([{ exit: 1, stderr: "not signed in" }], "broken");
    const refused = harness([{ events: [{ type: "error", message: "usage limit reached" }] }], "refused");
    const home = ghostHome();

    await expect(completeForHook({ ghost_home: home, prompt: "Classify." }, seams(broken, refused)))
      .rejects.toThrow(/broken: not signed in.*refused: usage limit reached/u);
    await expect(completeForHook({ ghost_home: home, prompt: "Classify." }, seams()))
      .rejects.toThrow(/No harness is eligible/u);
  });

  it("completes on the local model, as a turn would, never falling through to a cloud harness", async () => {
    const cloud = harness([{ events: [{ type: "text", block: "a", delta: "from the cloud" }] }], "cloud");
    const home = ghostHome();
    const local = localModel(" APPROVE ");

    await expect(completeForHook({ ghost_home: home, prompt: "Review this." }, { ...seams(cloud), local: local.model }))
      .resolves.toBe("APPROVE");
    expect(local.prompts).toEqual([[{ role: "user", content: "Review this." }]]);
    expect(cloud.calls()).toEqual([]);

    // A ghost that prefers a cloud harness keeps it.
    writeFileSync(join(home, "settings.yml"), "harness: cloud\n");
    await expect(completeForHook({ ghost_home: home, prompt: "Review this." }, { ...seams(cloud), local: local.model }))
      .resolves.toBe("from the cloud");
    expect(local.prompts).toHaveLength(1);

    // One that prefers the local model with none configured is refused, not sent to the cloud.
    writeFileSync(join(home, "settings.yml"), "harness: local\n");
    await expect(completeForHook({ ghost_home: home, prompt: "Review this." }, seams(cloud)))
      .rejects.toThrow(/none is configured/u);
    expect(cloud.calls()).toHaveLength(1);
  });

  it("rejects a non-ghost home, a relative path, and an empty prompt before running anything", async () => {
    const fake = harness([{ events: [{ type: "text", block: "a", delta: "never" }] }]);
    const notHome = mkdtempSync(join(tmpdir(), "ghost-not-home-"));
    dirs.push(notHome);
    const home = ghostHome();

    await expect(completeForHook({ ghost_home: notHome, prompt: "x" }, seams(fake))).rejects.toThrow(/not a Ghost home/u);
    await expect(completeForHook({ ghost_home: "ghosts/casper", prompt: "x" }, seams(fake))).rejects.toThrow(/absolute path/u);
    await expect(completeForHook({ ghost_home: home, prompt: "   " }, seams(fake))).rejects.toThrow(/non-empty/u);
    expect(fake.calls()).toEqual([]);
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
