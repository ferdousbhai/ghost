/**
 * The session host over a scripted harness: what a turn hands the harness
 * (persona, cwd, env, resume, MCP), what it streams back, what the
 * conversation log keeps, and how it chooses and falls back between harnesses.
 */
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GhostHookEvent } from "../src/hook-policy.js";
import { conversationDir, logPath, readLog } from "../src/conversation-log.js";
import { ghostPaths } from "../src/ghosts.js";
import { GhostHookRunner } from "../src/hooks.js";
import { readPinState } from "../src/pins.js";
import { readReadState } from "../src/reads.js";
import { HANDOFF_PROMPT, NEXT_WORK_PROMPT, SessionHost, type SessionHostOptions } from "../src/session-host.js";
import type { TurnEvent } from "../src/turn-events.js";
import { fakeHarness, onlyHarnesses, replies, type FakeHarness } from "./helpers/fake-harness.js";
import { makeTempGhosts, seedGhost, tempDir, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts;
const harnesses: FakeHarness[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
  temp?.cleanup();
});

function harness(...args: Parameters<typeof fakeHarness>): FakeHarness {
  const created = fakeHarness(...args);
  harnesses.push(created);
  return created;
}

function host(options: Partial<SessionHostOptions> & { harnesses: FakeHarness[] }): SessionHost {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper", character: "# Casper\n\nYou are Casper, a letterpress printer.\n" });
  const { harnesses: fakes, ...rest } = options;
  return new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    scheduleCliPath: "/usr/bin/ghost",
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    ...onlyHarnesses(...fakes),
    ...rest,
  });
}

async function turn(sessions: SessionHost, prompt: string, sessionId = "c1"): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await sessions.runTurn("casper", { sessionId, prompt, emit: (event) => events.push(event) });
  return events;
}

function text(events: readonly TurnEvent[]): string {
  return events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []).join("");
}

function sessionDir(): string {
  return ghostPaths(join(temp.root, "casper")).sessionDir;
}

describe("a turn", () => {
  it("runs the harness in the conversation's directory with the ghost's persona and identity", async () => {
    const fake = harness(replies("I set type."));
    const sessions = host({ harnesses: [fake] });
    const events = await turn(sessions, "What do you do?");

    expect(events[0]).toEqual({ type: "start" });
    expect(text(events)).toBe("I set type.");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const [call] = fake.calls();
    expect(call).toMatchObject({
      prompt: "What do you do?",
      resume: false,
      cwd: conversationDir(sessionDir(), "c1"),
      ghost: "casper",
      session: "c1",
      mcp: ["ghost"],
    });
    expect(call?.agents).toContain("You are Casper, a letterpress printer.");
    expect(call?.agents).toContain("## Character file");
    expect(existsSync(join(conversationDir(sessionDir(), "c1"), "CLAUDE.md"))).toBe(true);
  });

  it("re-renders the persona every turn, so a rewritten character is who the ghost is next", async () => {
    const fake = harness(replies("one", "two"));
    const sessions = host({ harnesses: [fake] });
    await turn(sessions, "first");
    writeFileSync(ghostPaths(join(temp.root, "casper")).characterFile, "# Casper\n\nYou are Casper, now a bookbinder.\n");
    await turn(sessions, "second");
    expect(fake.calls()[1]?.agents).toContain("now a bookbinder");
  });

  it("resumes the harness's own session on a later turn and records both in the log", async () => {
    const fake = harness(replies("pong", "pong again"));
    const sessions = host({ harnesses: [fake] });
    await turn(sessions, "ping");
    await turn(sessions, "again");

    expect(fake.calls().map((call) => [call.prompt, call.resume])).toEqual([["ping", false], ["again", true]]);
    const transcript = await sessions.readTranscript("casper", "c1");
    expect((await sessions.listSessions("casper")).find((row) => row.id === "c1")?.harness).toBe("fake");
    expect(transcript.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", [{ type: "text", text: "ping" }]],
      ["assistant", [{ type: "text", text: "pong" }]],
      ["user", [{ type: "text", text: "again" }]],
      ["assistant", [{ type: "text", text: "pong again" }]],
    ]);
  });

  it("streams tool calls as cards and keeps a failed one marked in the log", async () => {
    const fake = harness([{
      events: [
        { type: "tool_start", id: "t1", name: "Bash", args: { command: "false" } },
        { type: "tool_end", id: "t1", isError: true, output: "exit 1" },
        { type: "text", block: "a", delta: "It failed." },
      ],
    }]);
    const sessions = host({ harnesses: [fake] });
    const events = await turn(sessions, "run false");

    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", id: "t1", toolName: "Bash" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", id: "t1", isError: true, summary: "exit 1" }));
    const assistant = (await sessions.readTranscript("casper", "c1")).messages[1];
    expect(assistant?.content).toEqual([
      { type: "toolCall", id: "t1", name: "Bash", arguments: { command: "false" }, failed: true },
      { type: "text", text: "It failed." },
    ]);
  });

  it("ends in an error, not a fallback, when the harness failed after answering", async () => {
    const first = harness([{ events: [{ type: "text", block: "a", delta: "partial" }, { type: "error", message: "connection reset" }] }], "first");
    const second = harness(replies("unused"), "second");
    const sessions = host({ harnesses: [first, second] });
    const events = await turn(sessions, "hello");

    expect(events.at(-1)).toMatchObject({ type: "error", errorMessage: "connection reset" });
    expect(second.calls()).toEqual([]);
    expect((await sessions.readTranscript("casper", "c1")).messages[1]).toMatchObject({ errorMessage: "connection reset" });
  });
});

describe("harness choice", () => {
  it("hands a prompt the first harness refused to the next one", async () => {
    const refusing = harness([{ exit: 1, stderr: "Not logged in. Run login first." }], "first");
    const willing = harness(replies("here"), "second");
    const sessions = host({ harnesses: [refusing, willing] });
    const events = await turn(sessions, "hello");

    expect(text(events)).toBe("here");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((await sessions.listSessions("casper"))[0]?.harness).toBe("second");
    expect(events.filter((event) => event.type === "harness")).toEqual([
      { type: "harness", harness: "first" },
      { type: "harness", harness: "second" },
    ]);
  });

  it("lists the model and effort the carrying harness last reported, and forgets them on a switch", async () => {
    const first = harness([{ events: [{ type: "model", model: "gpt-6-astra", provider: "openai-codex" }, { type: "text", block: "r", delta: "hi" }] }], "first");
    const sessions = host({ harnesses: [first, harness(replies("hey"), "second")] });
    await turn(sessions, "hello");
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ harness: "first", model: "gpt-6-astra", provider: "openai-codex", effort: null });

    await sessions.chooseHarness("casper", "c1", "second");
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ harness: "second", model: null, provider: null, effort: null });
  });

  it("asks a harness whose output names no model for the session it reported", async () => {
    const quiet = harness([{ events: [{ type: "session", id: "thread-1" }, { type: "text", block: "r", delta: "hi" }] }], "quiet");
    const asked: string[] = [];
    Object.assign(quiet.row, {
      effort: "low",
      ranOn: async (session: string) => {
        asked.push(session);
        return { type: "model", model: "gpt-6.1-sol", provider: "openai", effort: "medium" };
      },
    });
    const sessions = host({ harnesses: [quiet] });
    await turn(sessions, "hello");
    expect(asked).toEqual(["thread-1"]);
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ model: "gpt-6.1-sol", provider: "openai", effort: "medium" });
  });

  it("names a quota refusal when no harness is left", async () => {
    const spent = harness([{ exit: 1, stderr: "You've hit your usage limit." }], "only");
    const sessions = host({ harnesses: [spent] });
    const events = await turn(sessions, "hello");

    expect(events).toContainEqual({ type: "limit_reached", harness: "only", kind: "usage_limit" });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("carries the conversation so far to a harness that takes over", async () => {
    const first = harness(replies("I am Casper.", "unused"), "first");
    const second = harness(replies("Still Casper."), "second");
    let eligible = ["first", "second"];
    const sessions = host({
      harnesses: [first, second],
      eligibleHarnesses: async () => eligible,
    });
    await turn(sessions, "Who are you?");
    eligible = ["second"];
    await turn(sessions, "And now?");

    const [call] = second.calls();
    expect(call?.resume).toBe(false);
    expect(call?.prompt).toContain("<conversation-so-far>\nOwner: Who are you?\n\nYou: I am Casper.\n</conversation-so-far>");
    expect(call?.prompt.endsWith("And now?")).toBe(true);
  });

  it("hands the log to the harness again after a home rename moves the conversation", async () => {
    const fake = harness(replies("I am Casper.", "Still here."));
    const sessions = host({ harnesses: [fake] });
    mkdirSync(join(temp.root, "casper", "skills"));
    await turn(sessions, "Who are you?");
    await sessions.renameGhost("casper", "wisp");
    const events: TurnEvent[] = [];
    await sessions.runTurn("wisp", { sessionId: "c1", prompt: "And now?", emit: (event) => events.push(event) });

    const second = fake.calls()[1];
    expect(second?.resume).toBe(false);
    expect(second?.cwd).toBe(conversationDir(ghostPaths(join(temp.root, "wisp")).sessionDir, "c1"));
    expect(second?.prompt).toContain("Owner: Who are you?");
    // The skills link named the old home; the turn points it at the new one.
    expect(readlinkSync(join(second?.cwd ?? "", ".claude", "skills"))).toBe(join(temp.root, "wisp", "skills"));
  });

  it("prefers the ghost's harness setting over Omarchy's order", async () => {
    const first = harness(replies("from first"), "first");
    const second = harness(replies("from second"), "second");
    const sessions = host({ harnesses: [first, second] });
    writeFileSync(join(temp.root, "casper", "settings.yml"), "harness: second\n");
    expect(text(await turn(sessions, "hi"))).toBe("from second");
  });

  it("fails plainly when no harness is eligible", async () => {
    const sessions = host({ harnesses: [], eligibleHarnesses: async () => [] });
    const events = await turn(sessions, "hi");
    expect(events.at(-1)).toMatchObject({ type: "error", errorMessage: expect.stringContaining("ghost harnesses") });
  });
});

describe("queued follow-ups and aborts", () => {
  it("runs a follow-up queued during a pass right after it, in the same stream", async () => {
    const fake = harness([]);
    const gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "first" }], gate: gate.path }, ...replies("second")]);
    const sessions = host({ harnesses: [fake] });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    expect(sessions.queuedMessages("casper", "c1").streaming).toBe(true);
    await sessions.queueMessage("casper", "c1", "two");
    gate.release();
    await running;

    // The stream announces the queue as it grows and as it drains, then the message.
    expect(events.filter((event) => event.type === "queue" || event.type === "owner_message")).toEqual([
      { type: "queue", followUp: ["two"] },
      { type: "queue", followUp: [] },
      { type: "owner_message", text: "two" },
    ]);
    expect(text(events)).toBe("firstsecond");
    expect(fake.calls().map((call) => [call.prompt, call.resume])).toEqual([["one", false], ["two", true]]);
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
  });

  it("announces a turn's start with its prompt already in the transcript", async () => {
    const fake = harness([]);
    const gate = fake.gate("hold");
    fake.setTurns([{ gate: gate.path, events: [{ type: "text", block: "a", delta: "ok" }] }]);
    const sessions = host({ harnesses: [fake] });
    const seen: string[][] = [];
    sessions.subscribeConversationEvents("casper", () => {
      seen.push([]);
      const slot = seen.length - 1;
      void sessions.readTranscript("casper", "c1", {}).then((transcript) => {
        seen[slot] = transcript.messages.filter((message) => message.role === "user")
          .map((message) => message.content.map((part) => part.type === "text" ? part.text : "").join(""));
      });
    }, () => {});
    const running = turn(sessions, "check the issues");
    await waitFor(() => fake.calls().length === 1);
    expect(seen[0]).toEqual(["check the issues"]);
    gate.release();
    await running;
  });

  it("logs text after a tool call as its own part when the harness reuses the block key", async () => {
    const fake = harness([]);
    fake.setTurns([{ events: [
      { type: "text", block: "run", delta: "Let me check." },
      { type: "tool_start", id: "t1", name: "bash", args: { command: "ls" } },
      { type: "tool_end", id: "t1", isError: false, output: "ok" },
      { type: "text", block: "run", delta: "Done: X" },
    ] }]);
    const sessions = host({ harnesses: [fake] });
    await turn(sessions, "check it");
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.at(-1)?.content.map((part) => part.type === "text" ? part.text : part.type))
      .toEqual(["Let me check.", "toolCall", "Done: X"]);
  });

  it("still runs a follow-up queued behind a pass that failed", async () => {
    const fake = harness([]);
    const gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "half" }], exit: 1, stderr: "crashed", gate: gate.path }, ...replies("second")]);
    const sessions = host({ harnesses: [fake] });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    await sessions.queueMessage("casper", "c1", "two");
    gate.release();
    await running;
    expect(fake.calls().map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(events.at(-1)).toEqual({ type: "done" });
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.map((message) => [message.role, message.errorMessage ?? null])).toEqual([
      ["user", null], ["assistant", "crashed"], ["user", null], ["assistant", null],
    ]);
  });

  it("refuses a stop when nothing is running", () => {
    const sessions = host({ harnesses: [harness(replies("x"))] });
    expect(() => sessions.stopTurn("casper", "c1")).toThrow(expect.objectContaining({ code: "session_not_streaming" }));
  });

  it("refuses a queued message when nothing is streaming", async () => {
    const sessions = host({ harnesses: [harness(replies("x"))] });
    await expect(sessions.queueMessage("casper", "c1", "late")).rejects.toMatchObject({ code: "session_not_streaming" });
  });

  it("kills the harness on stop and ends the turn aborted", async () => {
    const fake = harness([]);
    fake.setTurns([{ gate: fake.gate("never").path }]);
    const sessions = host({ harnesses: [fake] });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "wait", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ id: "c1", running: true });
    sessions.stopTurn("casper", "c1");
    await running;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ id: "c1", running: false });
  });
});

describe("owner commands and hooks", () => {
  function recordingStopHook(gated = false): {
    hooks: GhostHookRunner;
    started: string;
    go: string;
    inputs: () => GhostHookEvent[];
  } {
    const scratch = tempDir();
    cleanups.push(scratch.cleanup);
    const script = join(scratch.path, "hook.mjs");
    const observed = join(scratch.path, "inputs.jsonl");
    const started = join(scratch.path, "started");
    const seen = join(scratch.path, "seen");
    const go = join(scratch.path, "go");
    writeFileSync(script, `
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      import { setTimeout } from "node:timers/promises";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const event = JSON.parse(input);
      appendFileSync(${JSON.stringify(observed)}, JSON.stringify(event) + "\\n");
      if (event.type === "session_stop") {
        writeFileSync(${JSON.stringify(started)}, "");
        if (${gated}) while (!existsSync(${JSON.stringify(go)})) await setTimeout(20);
        const block = ${gated} ? !existsSync(${JSON.stringify(seen)}) : !event.stop_hook_active;
        writeFileSync(${JSON.stringify(seen)}, "");
        process.stdout.write(JSON.stringify(block ? { decision: "block", reason: "verify it" } : {}));
      } else process.stdout.write("{}");
    `);
    const hooksPath = join(scratch.path, "hooks.json");
    const hook = { type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, name: "Review" };
    writeFileSync(hooksPath, JSON.stringify({ hooks: {
      before_prompt: [{ hooks: [hook] }],
      session_stop: [{ hooks: [hook] }],
    } }));
    return {
      hooks: GhostHookRunner.fromConfig(hooksPath),
      started,
      go,
      inputs: () => readFileSync(observed, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    };
  }

  it("runs `!command` in the owner home and hands its output to the next turn", async () => {
    const fake = harness(replies("seen"));
    const sessions = host({ harnesses: [fake] });
    const events = await turn(sessions, "!echo printed-$GHOST_SESSION");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "bash", isError: false }));
    expect(fake.calls()).toEqual([]);
    // Read back as the live turn showed it: the owner's `!command`, then its output.
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.map((message) => [message.role, message.entryId])).toEqual([["user", "e1"], ["assistant", "e1o"]]);
    expect(messages[0]?.content).toEqual([{ type: "text", text: "!echo printed-$GHOST_SESSION" }]);

    await turn(sessions, "what did I run?");
    const [call] = fake.calls();
    expect(call?.prompt).toContain("Owner ran `echo printed-$GHOST_SESSION`");
    expect(call?.prompt).toContain("printed-c1");
  });

  it("stops a running `!command`", async () => {
    const sessions = host({ harnesses: [harness([])] });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "!sleep 30", emit: (event) => events.push(event) });
    await waitFor(() => events.some((event) => event.type === "tool_execution_start"));
    // A command has no passes to queue after; it is busy, not idle.
    await expect(sessions.queueMessage("casper", "c1", "after")).rejects.toMatchObject({ code: "session_busy" });
    sessions.stopTurn("casper", "c1");
    await running;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted", errorMessage: "Command aborted." });
  });

  it("lists a conversation of owner commands while one runs and after", async () => {
    const sessions = host({ harnesses: [harness(replies("on it"))] });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c9", prompt: "!sleep 30", emit: (event) => events.push(event) });
    await waitFor(() => events.some((event) => event.type === "tool_execution_start"));
    expect(await sessions.listSessions("casper")).toEqual([expect.objectContaining({ id: "c9", running: true, messageCount: 0 })]);
    sessions.stopTurn("casper", "c9");
    await running;
    expect(await sessions.listSessions("casper")).toEqual([
      expect.objectContaining({ id: "c9", running: false, messageCount: 2, preview: "!sleep 30" }),
    ]);

    // The first owner message still titles it; the command keeps the preview.
    await turn(sessions, "fix the failing build please", "c9");
    expect((await sessions.listSessions("casper"))[0]).toMatchObject({ id: "c9", title: "Fix the failing build please", preview: "!sleep 30" });

    // `!!` output is kept from the transcript too, so it alone is no conversation.
    await turn(sessions, "!!echo hidden", "c8");
    expect((await sessions.listSessions("casper")).map((row) => row.id)).not.toContain("c8");
  });

  it("fences a command's output so a ``` line inside stays code", async () => {
    const sessions = host({ harnesses: [harness([])] });
    await turn(sessions, "!printf '# Readme\\n```sh\\nls\\n```\\n'");
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.at(-1)?.content).toEqual([{ type: "text", text: "````\n# Readme\n```sh\nls\n```\n````" }]);
  });

  it("hands a message that is only a photo to the harness, not to bash", async () => {
    const fake = harness(replies("a red bicycle"));
    const sessions = host({ harnesses: [fake] });
    const events = await turn(sessions, "![image](attachments/k1-photo.jpg)");
    expect(events.some((event) => event.type === "tool_execution_start" && event.toolName === "bash")).toBe(false);
    expect(fake.calls()[0]?.prompt).toContain("![image](attachments/k1-photo.jpg)");

    // `!!` keeps a command whose text opens with `[` out of the ghost's context.
    const kept = await turn(sessions, "!![ -d / ] && echo kept", "c2");
    expect(kept).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "bash", isError: false }));
    const { messages } = await sessions.readTranscript("casper", "c2", {});
    expect(messages).toEqual([]);
  });

  it("keeps `!!command` output from the ghost", async () => {
    const fake = harness(replies("ok", "ok"));
    const sessions = host({ harnesses: [fake] });
    await turn(sessions, "hello");
    await turn(sessions, "!!echo secret");
    await turn(sessions, "next");
    expect(fake.calls()[1]?.prompt).toBe("next");
  });

  it("continues the turn while a session_stop hook asks it to", async () => {
    const stop = recordingStopHook();
    const fake = harness(replies("done", "verified"));
    const sessions = host({ harnesses: [fake], hooks: stop.hooks });
    const events = await turn(sessions, "do it");

    // Each run of the hook is bracketed by its name and event, so a client can
    // tell a stop hook, which runs after the reply is complete, from one the
    // reply waits on.
    const hookEvents = events.filter((event) => event.type === "hook_start" || event.type === "hook_end"
      || event.type === "session_stop_continued" || event.type === "done");
    expect(hookEvents).toEqual([
      { type: "hook_start", name: "Review", event: "before_prompt" },
      { type: "hook_end", name: "Review", event: "before_prompt" },
      { type: "hook_start", name: "Review", event: "session_stop" },
      { type: "hook_end", name: "Review", event: "session_stop" },
      { type: "session_stop_continued", reason: "verify it" },
      { type: "hook_start", name: "Review", event: "session_stop" },
      { type: "hook_end", name: "Review", event: "session_stop" },
      expect.objectContaining({ type: "done" }),
    ]);
    expect(fake.calls()[1]?.prompt).toBe("Stop hook feedback:\nverify it");
    expect((await sessions.readTranscript("casper", "c1")).messages.map((message) => message.role)).toEqual(["user", "assistant", "hook", "assistant"]);
    const [before, first, continued] = stop.inputs();
    expect(before).toMatchObject({ type: "before_prompt", prompt: "do it", turn_id: expect.any(String) });
    expect(first).toMatchObject({ type: "session_stop", owner_prompt: "do it", turn_id: before?.turn_id, stop_hook_active: false });
    expect(continued).toMatchObject({ type: "session_stop", owner_prompt: "do it", turn_id: before?.turn_id, stop_hook_active: true });
  });

  it("gives repeated identical owner requests distinct hook identities", async () => {
    const stop = recordingStopHook();
    const fake = harness(replies("done", "verified", "done again", "verified again"));
    const sessions = host({ harnesses: [fake], hooks: stop.hooks });
    await turn(sessions, "do it");
    await turn(sessions, "do it");
    const ids = stop.inputs().map((input) => input.turn_id);
    expect(ids).toEqual([ids[0], ids[0], ids[0], ids[3], ids[3], ids[3]]);
    expect(ids[3]).not.toBe(ids[0]);
  });

  it("does not ask the stop hook while the owner's follow-up waits", async () => {
    const stop = recordingStopHook(true);
    writeFileSync(stop.go, "");
    const fake = harness([]);
    const gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "first" }], gate: gate.path }, ...replies("second", "verified")]);
    const sessions = host({ harnesses: [fake], hooks: stop.hooks });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    await sessions.queueMessage("casper", "c1", "two");
    gate.release();
    await running;

    // The first pass is not reviewed; the follow-up's own pass is.
    expect(fake.calls().map((call) => call.prompt)).toEqual(["one", "two", "Stop hook feedback:\nverify it"]);
    expect(events.findIndex((event) => event.type === "owner_message"))
      .toBeLessThan(events.findIndex((event) => event.type === "session_stop_continued"));
    const [before, followUp, reviewed, continued] = stop.inputs();
    expect(followUp?.turn_id).not.toBe(before?.turn_id);
    expect(followUp).toMatchObject({ type: "before_prompt", prompt: "two", turn_id: expect.any(String) });
    expect(reviewed).toMatchObject({ type: "session_stop", owner_prompt: "two", turn_id: followUp?.turn_id, stop_hook_active: false });
    expect(continued).toMatchObject({ type: "session_stop", owner_prompt: "two", turn_id: followUp?.turn_id, stop_hook_active: true });
  });

  it("lets a follow-up sent while the stop hook runs win over its continuation", async () => {
    const stop = recordingStopHook(true);
    const fake = harness(replies("first", "second"));
    const sessions = host({ harnesses: [fake], hooks: stop.hooks });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => existsSync(stop.started));
    await sessions.queueMessage("casper", "c1", "two");
    writeFileSync(stop.go, "");
    await running;

    expect(fake.calls().map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(events).toContainEqual({ type: "owner_message", text: "two" });
    expect(events.some((event) => event.type === "session_stop_continued")).toBe(false);
    const [before, first, followUp, reviewed] = stop.inputs();
    expect(first).toMatchObject({ owner_prompt: "one", turn_id: before?.turn_id });
    expect(followUp?.turn_id).not.toBe(before?.turn_id);
    expect(reviewed).toMatchObject({ owner_prompt: "two", turn_id: followUp?.turn_id, stop_hook_active: false });
  });
});

describe("choosing the agent", () => {
  it("lists the agents with both defaults, and sets and clears the ghost's own", async () => {
    const first = harness(replies("from first"), "first");
    const second = harness(replies("from second"), "second");
    const sessions = host({ harnesses: [first, second], defaultHarness: async () => "first" });
    const settings = join(temp.root, "casper", "settings.yml");
    writeFileSync(settings, "# the owner's note\nother: kept\n");

    expect(await sessions.listHarnesses("casper")).toMatchObject({
      harnesses: [{ id: "first", eligible: true, effort: null }, { id: "second", eligible: true, effort: null }],
      ghostDefault: null,
      omarchyDefault: "first",
    });
    expect((await sessions.setGhostHarness("casper", "second")).ghostDefault).toBe("second");
    expect(readFileSync(settings, "utf8")).toBe("# the owner's note\nother: kept\nharness: second\n");
    expect(text(await turn(sessions, "hi"))).toBe("from second");

    expect((await sessions.setGhostHarness("casper", null)).ghostDefault).toBeNull();
    expect(readFileSync(settings, "utf8")).toBe("# the owner's note\nother: kept\n");
    await expect(sessions.setGhostHarness("casper", "nope")).rejects.toMatchObject({ code: "unknown_harness" });
  });

  it("switches one conversation, handing the new agent the conversation so far", async () => {
    const first = harness(replies("I am Casper.", "unused"), "first");
    const second = harness(replies("Still Casper."), "second");
    const sessions = host({ harnesses: [first, second] });
    await turn(sessions, "Who are you?");
    await sessions.chooseHarness("casper", "c1", "second");
    expect(text(await turn(sessions, "And now?"))).toBe("Still Casper.");

    const [call] = second.calls();
    expect(call?.resume).toBe(false);
    expect(call?.prompt).toContain("Owner: Who are you?\n\nYou: I am Casper.");
    expect((await sessions.listSessions("casper"))[0]?.harness).toBe("second");
    await expect(sessions.chooseHarness("casper", "c1", "nope")).rejects.toMatchObject({ code: "unknown_harness" });
    // A new conversation can be pointed at an agent before its first turn.
    await sessions.chooseHarness("casper", "c2", "first");
    await turn(sessions, "hello", "c2");
    expect(first.calls().map((c) => c.prompt)).toContain("hello");
  });
  it("a switch stops a running idle handoff before changing the carrying harness", async () => {
    const first = harness([], "first");
    const held = first.gate("handoff");
    first.setTurns([...replies("done"), { gate: held.path }, ...replies("unused")]);
    const second = harness(replies("new harness"), "second");
    const sessions = host({ harnesses: [first, second], hooks: idle(20, 0) });
    await turn(sessions, "start");
    await waitFor(() => first.calls().length === 2);

    await sessions.chooseHarness("casper", "c1", "second");
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await readLog(sessionDir(), "c1"))?.some((entry) => entry.type === "handoff")).toBe(false);
    expect(text(await turn(sessions, "continue"))).toBe("new harness");
  });

  it("a running turn cannot have its harness switched underneath it", async () => {
    const first = harness([], "first");
    const held = first.gate("turn");
    first.setTurns([{ gate: held.path, ...replies("done")[0] }]);
    const sessions = host({ harnesses: [first, harness(replies("unused"), "second")] });
    const running = turn(sessions, "start");
    await waitFor(() => first.calls().length === 1);

    await expect(sessions.chooseHarness("casper", "c1", "second")).rejects.toMatchObject({ code: "session_busy" });
    held.release();
    await running;
    expect((await sessions.listSessions("casper"))[0]?.harness).toBe("first");
  });
  it("refuses to switch to an agent a turn would pass over", async () => {
    const fake = harness(replies("x"));
    const sessions = host({
      harnesses: [fake],
      harnessReport: async () => ({
        harnesses: [{ id: "fake", eligible: false, reason: "Weekly at 95%", usage: null }],
        refresh: "omarchy agent usage update",
      }),
    });
    await expect(sessions.chooseHarness("casper", "c1", "fake")).rejects.toMatchObject({ code: "harness_no_room", message: "fake has no room: Weekly at 95%." });
  });
  it("shares one harness report between the picker, a choice, and a turn", async () => {
    const fake = harness(replies("x"));
    let reports = 0;
    const sessions = host({
      harnesses: [fake],
      harnessReport: async () => {
        reports += 1;
        return { harnesses: [{ id: "fake", eligible: true, reason: null, usage: null }], refresh: "omarchy agent usage update" };
      },
    });
    await sessions.listHarnesses("casper");
    await sessions.chooseHarness("casper", "c1", "fake");
    await turn(sessions, "hello");
    expect(reports).toBe(1);
  });
});

describe("conversation metadata", () => {
  it("keeps concurrent pin and read changes to different conversations", async () => {
    const sessions = host({ harnesses: [harness(replies("one", "two"))] });
    await turn(sessions, "first", "c1");
    await turn(sessions, "second", "c2");

    await Promise.all([
      sessions.setPinned("casper", "c1", true),
      sessions.setPinned("casper", "c2", true),
    ]);
    expect((await readPinState(sessionDir())).pinned.sort()).toEqual(["c1", "c2"]);

    await Promise.all([
      sessions.markRead("casper", "c1"),
      sessions.markRead("casper", "c2"),
    ]);
    expect(Object.keys((await readReadState(sessionDir())).reads).sort()).toEqual(["c1", "c2"]);
  });

  it("refuses metadata writes while the ghost home is moving", async () => {
    const sessions = host({ harnesses: [harness(replies("hi"))] });
    await turn(sessions, "hello");
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lease = sessions.withGhost("casper", () => held);
    const deleting = sessions.deleteGhost("casper");
    try {
      await expect(sessions.setPinned("casper", "c1", true)).rejects.toMatchObject({ code: "ghost_busy" });
      await expect(sessions.markRead("casper", "c1")).rejects.toMatchObject({ code: "ghost_busy" });
      await expect(sessions.renameConversation("casper", "c1", "Moved")).rejects.toMatchObject({ code: "ghost_busy" });
    } finally {
      release();
      await lease;
      await deleting;
    }
  });

  it("lists, titles, pins, reads, and trashes a conversation", async () => {
    const sessions = host({ harnesses: [harness(replies("hi"))] });
    await turn(sessions, "Plan the zine\nwith details");
    let [row] = await sessions.listSessions("casper");
    expect(row).toMatchObject({ id: "c1", title: "Plan the zine", preview: "Plan the zine", messageCount: 2, pinned: false, unread: true });

    await sessions.renameConversation("casper", "c1", "Zine");
    await sessions.setPinned("casper", "c1", true);
    await sessions.markRead("casper", "c1", new Date(Date.now() + 60_000));
    [row] = await sessions.listSessions("casper");
    expect(row).toMatchObject({ title: "Zine", pinned: true, unread: false });

    const trashed = await sessions.deleteSession("casper", "c1");
    expect(existsSync(trashed.trash)).toBe(true);
    expect(existsSync(conversationDir(sessionDir(), "c1"))).toBe(false);
    expect(await sessions.listSessions("casper")).toEqual([]);
  });

  it("skips a torn last log line", async () => {
    const sessions = host({ harnesses: [harness(replies("hi"))] });
    await turn(sessions, "hello");
    const before = (await readLog(sessionDir(), "c1"))?.length;
    writeFileSync(logPath(sessionDir(), "c1"), `${readFileSync(logPath(sessionDir(), "c1"), "utf8")}{"type":"us`);
    expect((await readLog(sessionDir(), "c1"))?.length).toBe(before);
  });
});

/** A hook runner with only ghostd's idle settings: handoff after `ms`, then up to `turns` next-work turns. */
function idle(ms: number, turns: number): GhostHookRunner {
  return new GhostHookRunner({ builtin: { handoffIdleMs: ms, nextWorkTurns: turns } });
}

describe("the idle handoff", () => {
  it("resumes the conversation's session once it sits idle and logs the reply as one handoff row", async () => {
    const fake = harness(replies("done", "Updated plan.md"));
    const sessions = host({ harnesses: [fake], hooks: idle(20, 0) });
    await turn(sessions, "ship it");
    await waitFor(() => fake.calls().length === 2);
    expect(fake.calls()[1]).toMatchObject({ prompt: HANDOFF_PROMPT, resume: true });
    await waitFor(() => (readFileSync(logPath(sessionDir(), "c1"), "utf8")).includes('"type":"handoff"'));
    const { messages } = await sessions.readTranscript("casper", "c1");
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", [{ type: "text", text: "ship it" }]],
      ["assistant", [{ type: "text", text: "done" }]],
      ["handoff", [{ type: "text", text: "Updated plan.md" }]],
    ]);
    // The handoff is not news: the listing still dates the conversation by its reply.
    const reply = (await readLog(sessionDir(), "c1"))?.findLast((entry) => entry.type === "assistant");
    expect((await sessions.listSessions("casper")).find((row) => row.id === "c1")?.updatedAt).toBe(reply?.at);
  });

  it("gives way to the owner: a new turn stops a running handoff and nothing is logged for it", async () => {
    const fake = harness([]);
    const held = fake.gate("handoff");
    fake.setTurns([...replies("done"), { gate: held.path }, ...replies("next answer")]);
    const sessions = host({ harnesses: [fake], hooks: idle(20, 0) });
    await turn(sessions, "ship it");
    await waitFor(() => fake.calls().length === 2);
    expect(text(await turn(sessions, "one more thing"))).toBe("next answer");
    expect(fake.calls()[2]?.prompt).toBe("one more thing");
    expect((await readLog(sessionDir(), "c1"))?.some((entry) => entry.type === "handoff")).toBe(false);
  });

  it("schedules nothing after a turn the owner stopped: the owner is present", async () => {
    const fake = harness([]);
    const first = fake.gate("first");
    fake.setTurns([{ gate: first.path, ...replies("done")[0] }, { gate: fake.gate("never").path }, ...replies("unexpected")]);
    const sessions = host({ harnesses: [fake], hooks: idle(20, 5) });
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "start", emit: () => {} });
    await waitFor(() => fake.calls().length === 1);
    // The follow-up's pass resumes a session that has replied, so a handoff could run after it.
    await sessions.queueMessage("casper", "c1", "and wait");
    first.release();
    await waitFor(() => fake.calls().length === 2);
    sessions.stopTurn("casper", "c1");
    await running;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.calls()).toHaveLength(2);
  });

  it("counts down no next-work turn when the owner writes as a handoff is logged", async () => {
    const fake = harness(replies("done", "noted", "answer", "noted again", "unexpected"));
    const sessions = host({ harnesses: [fake], hooks: idle(20, 5), nextWorkCountdownMs: 400 });
    await turn(sessions, "ship it");
    let owner: Promise<TurnEvent[]> | undefined;
    sessions.subscribeConversationEvents("casper", () => {
      if (!owner && readFileSync(logPath(sessionDir(), "c1"), "utf8").includes('"type":"handoff"')) owner = turn(sessions, "I'm back");
    });
    await waitFor(() => owner !== undefined);
    expect(text(await (owner as Promise<TurnEvent[]>))).toBe("answer");
    // The owner's turn schedules its own handoff; a countdown left by the first would take its place.
    await waitFor(() => fake.calls().length === 4);
    expect(fake.calls()[3]?.prompt).toBe(HANDOFF_PROMPT);
  });

  it("refuses a turn when shutdown begins while it waits out a running handoff", async () => {
    const fake = harness([]);
    const held = fake.gate("handoff");
    fake.setTurns([...replies("done"), { gate: held.path }, ...replies("unexpected")]);
    const sessions = host({ harnesses: [fake], hooks: idle(20, 0) });
    await turn(sessions, "ship it");
    await waitFor(() => fake.calls().length === 2);
    const admitted = sessions.admitTurn("casper", { sessionId: "c1", prompt: "late" });
    sessions.beginShutdown();
    await expect(admitted).rejects.toMatchObject({ code: "shutting_down" });
  });

  it("keeps the ghost working after each handoff, up to next_work_turns since the owner wrote", async () => {
    const fake = harness(replies("done", "noted", "idea one", "noted", "idea two", "noted", "unexpected"));
    const sessions = host({ harnesses: [fake], hooks: idle(20, 2), nextWorkCountdownMs: 20 });
    await turn(sessions, "ship it");
    await waitFor(() => fake.calls().length === 6);
    await waitFor(() => (readFileSync(logPath(sessionDir(), "c1"), "utf8")).split('"type":"handoff"').length === 4);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.calls().map((call) => call.prompt)).toEqual([
      "ship it", HANDOFF_PROMPT, NEXT_WORK_PROMPT, HANDOFF_PROMPT, NEXT_WORK_PROMPT, HANDOFF_PROMPT,
    ]);
    const { messages } = await sessions.readTranscript("casper", "c1");
    expect(messages.map((message) => message.role)).toEqual([
      "user", "assistant", "handoff", "auto", "assistant", "handoff", "auto", "assistant", "handoff",
    ]);
  });

  it("starts no next-work turn after a failed handoff", async () => {
    const fake = harness([...replies("done"), { exit: 1, stderr: "out of quota" }, ...replies("unexpected")]);
    const sessions = host({ harnesses: [fake], hooks: idle(20, 5), nextWorkCountdownMs: 20 });
    await turn(sessions, "ship it");
    await waitFor(() => (readFileSync(logPath(sessionDir(), "c1"), "utf8")).includes('"type":"handoff"'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.calls()).toHaveLength(2);
    expect((await sessions.listSessions("casper")).find((row) => row.id === "c1")?.continuesAt).toBeNull();
  });

  it("reads the settings when a step starts, so turning the chain off stops one already scheduled", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const config = join(dir.path, "hooks.json");
    writeFileSync(config, JSON.stringify({ builtin: { handoff_idle_seconds: 1 } }));
    const hooks = GhostHookRunner.fromConfig(config);
    const fake = harness(replies("done", "unexpected"));
    const sessions = host({ harnesses: [fake], hooks });
    await turn(sessions, "ship it");
    await hooks.replaceConfig({ builtin: { handoff_idle_seconds: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(fake.calls()).toHaveLength(1);
  });

  it("starts no next-work turn once handoff_idle_seconds turns the chain off during its countdown", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const config = join(dir.path, "hooks.json");
    writeFileSync(config, JSON.stringify({ builtin: { handoff_idle_seconds: 1 } }));
    const hooks = GhostHookRunner.fromConfig(config);
    const fake = harness(replies("done", "noted", "unexpected"));
    const sessions = host({ harnesses: [fake], hooks, nextWorkCountdownMs: 300 });
    await turn(sessions, "ship it");
    const row = async () => (await sessions.listSessions("casper")).find((listed) => listed.id === "c1");
    for (let tries = 0; !(await row())?.continuesAt; tries += 1) {
      if (tries > 400) throw new Error("no countdown");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await hooks.replaceConfig({ builtin: { handoff_idle_seconds: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fake.calls()).toHaveLength(2);
  });

  it("lists the countdown, and the owner's cancel stops the next-work turn", async () => {
    const fake = harness(replies("done", "noted", "unexpected"));
    const sessions = host({ harnesses: [fake], hooks: idle(20, 5), nextWorkCountdownMs: 60_000 });
    await turn(sessions, "ship it");
    const row = async () => (await sessions.listSessions("casper")).find((listed) => listed.id === "c1");
    for (let tries = 0; !(await row())?.continuesAt; tries += 1) {
      if (tries > 200) throw new Error("no countdown");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await sessions.cancelNextWork("casper", "c1");
    expect((await row())?.continuesAt).toBeNull();
    expect(fake.calls()).toHaveLength(2);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
