/**
 * The session host over a scripted answerer: what a turn hands a pass
 * (persona, cwd, env), what it streams back, and what the conversation log
 * keeps.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHooksDocument, type GhostHookEvent } from "../src/hook-policy.js";
import { conversationDir, logPath, readLog } from "../src/conversation-log.js";
import { ghostPaths } from "../src/ghosts.js";
import { GhostHookRunner } from "../src/hooks.js";
import { readPins, readReads } from "../src/sidecars.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
import type { TurnEvent } from "../src/turn-events.js";
import { fakeAnswerer, answeredBy, replies, type FakeAnswerer } from "./helpers/fake-answerer.js";
import { makeTempGhosts, seedGhost, tempDir, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts;
const fakes: FakeAnswerer[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
  temp?.cleanup();
});

function harness(...args: Parameters<typeof fakeAnswerer>): FakeAnswerer {
  const created = fakeAnswerer(...args);
  fakes.push(created);
  return created;
}

function host(options: Partial<SessionHostOptions> & { fake: FakeAnswerer }): SessionHost {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper", character: "# Casper\n\nYou are Casper, a letterpress printer.\n" });
  const { fake, ...rest } = options;
  return new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    ...answeredBy(fake),
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
    const sessions = host({ fake: fake });
    const events = await turn(sessions, "What do you do?");

    expect(events[0]).toEqual({ type: "start" });
    expect(text(events)).toBe("I set type.");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const [call] = fake.calls();
    expect(call).toMatchObject({
      prompt: "What do you do?",
      cwd: conversationDir(sessionDir(), "c1"),
      ghost: "casper",
      session: "c1",
    });
    expect(call?.persona).toContain("You are Casper, a letterpress printer.");
    expect(call?.persona).toContain("## Character file");
    // The persona reaches the model directly: no file of it is left for a coding agent run there to read.
    expect(existsSync(join(conversationDir(sessionDir(), "c1"), "CLAUDE.md"))).toBe(false);
  });

  it("re-renders the persona every turn, so a rewritten character is who the ghost is next", async () => {
    const fake = harness(replies("one", "two"));
    const sessions = host({ fake: fake });
    await turn(sessions, "first");
    writeFileSync(ghostPaths(join(temp.root, "casper")).characterFile, "# Casper\n\nYou are Casper, now a bookbinder.\n");
    await turn(sessions, "second");
    expect(fake.calls()[1]?.persona).toContain("now a bookbinder");
  });

  it("hands a later turn the conversation so far and records both in the log", async () => {
    const fake = harness(replies("pong", "pong again"));
    const sessions = host({ fake: fake });
    await turn(sessions, "ping");
    await turn(sessions, "again");

    expect(fake.calls().map((call) => call.prompt)).toEqual(["ping", "<conversation-so-far>\nOwner: ping\n\nYou: pong\n</conversation-so-far>\n\nagain"]);
    const transcript = await sessions.readTranscript("casper", "c1");
    expect((await sessions.listSessions("casper")).find((row) => row.id === "c1")?.harness).toBe("local");
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
    const sessions = host({ fake: fake });
    const events = await turn(sessions, "run false");

    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", id: "t1", toolName: "Bash" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", id: "t1", isError: true, summary: "exit 1" }));
    const assistant = (await sessions.readTranscript("casper", "c1")).messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "toolCall", id: "t1", name: "Bash", arguments: { command: "false" }, failed: true },
      { type: "text", text: "It failed." },
    ]);
  });

  // pi reports a failed request, then retries it itself: the retry's answer stands.
  it("ends in an error that keeps what was said before it", async () => {
    const fake = harness([{ events: [{ type: "text", block: "a", delta: "partial" }], fail: "connection reset" }]);
    const sessions = host({ fake: fake });
    const events = await turn(sessions, "hello");

    expect(events.at(-1)).toMatchObject({ type: "error", errorMessage: "connection reset" });
    expect((await sessions.readTranscript("casper", "c1")).messages.find((message) => message.role === "assistant"))
      .toMatchObject({ errorMessage: "connection reset", content: [{ type: "text", text: "partial" }] });
  });

  it("names the coding agent the owner chose to the pass", async () => {
    const fake = harness(replies("ok"));
    const sessions = host({ fake: fake, codingAgent: async () => "codex" });
    await turn(sessions, "hi");
    expect(fake.calls()[0]?.codingAgent).toBe("codex");
  });
});

describe("where a turn runs", () => {
  it("runs in the home's new place after the owner moved it under another name", async () => {
    const fake = harness(replies("I am Casper.", "Still here."));
    const sessions = host({ fake: fake });
    await turn(sessions, "Who are you?");
    renameSync(join(temp.root, "casper"), join(temp.root, "wisp"));
    const events: TurnEvent[] = [];
    await sessions.runTurn("wisp", { sessionId: "c1", prompt: "And now?", emit: (event) => events.push(event) });

    const second = fake.calls()[1];
    expect(second?.cwd).toBe(conversationDir(ghostPaths(join(temp.root, "wisp")).sessionDir, "c1"));
    expect(second?.prompt).toContain("Owner: Who are you?");
  });

  it("fails plainly when no local model is configured", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const sessions = new SessionHost({ registry: temp.registry, ownerHome: temp.ownerHome });
    const events = await turn(sessions, "hi");
    expect(events.at(-1)).toMatchObject({ type: "error", errorMessage: expect.stringContaining("local.model") });
    await expect(sessions.complete("casper", "Review this.", new AbortController().signal)).rejects.toMatchObject({ code: "no_local_model" });
  });
});

describe("queued follow-ups and aborts", () => {
  it("runs a follow-up queued during a pass right after it, in the same stream", async () => {
    const fake = harness([]);
    const gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "first" }], gate: gate.path }, ...replies("second")]);
    const sessions = host({ fake: fake });
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
    expect(fake.calls().map((call) => call.prompt.split("\n").at(-1))).toEqual(["one", "two"]);
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
  });

  it("announces a turn's start with its prompt already in the transcript", async () => {
    const fake = harness([]);
    const gate = fake.gate("hold");
    fake.setTurns([{ gate: gate.path, events: [{ type: "text", block: "a", delta: "ok" }] }]);
    const sessions = host({ fake: fake });
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
    const sessions = host({ fake: fake });
    await turn(sessions, "check it");
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.at(-1)?.content.map((part) => part.type === "text" ? part.text : part.type))
      .toEqual(["Let me check.", "toolCall", "Done: X"]);
  });

  it("still runs a follow-up queued behind a pass that failed", async () => {
    const fake = harness([]);
    const gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "half" }], fail: "crashed", gate: gate.path }, ...replies("second")]);
    const sessions = host({ fake: fake });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    await sessions.queueMessage("casper", "c1", "two");
    gate.release();
    await running;
    expect(fake.calls().map((call) => call.message)).toEqual(["one", "two"]);
    expect(events.at(-1)).toEqual({ type: "done" });
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.map((message) => [message.role, message.errorMessage ?? null])).toEqual([
      ["user", null], ["assistant", "crashed"], ["user", null], ["assistant", null],
    ]);
  });

  it("refuses a stop when nothing is running", () => {
    const sessions = host({ fake: harness(replies("x")) });
    expect(() => sessions.stopTurn("casper", "c1")).toThrow(expect.objectContaining({ code: "session_not_streaming" }));
  });

  it("refuses a queued message when nothing is streaming", async () => {
    const sessions = host({ fake: harness(replies("x")) });
    await expect(sessions.queueMessage("casper", "c1", "late")).rejects.toMatchObject({ code: "session_not_streaming" });
  });

  it("stops the pass on stop and ends the turn aborted", async () => {
    const fake = harness([]);
    fake.setTurns([{ gate: fake.gate("never").path }]);
    const sessions = host({ fake: fake });
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
      writeFileSync(${JSON.stringify(started)}, "");
      if (${gated}) while (!existsSync(${JSON.stringify(go)})) await setTimeout(20);
      const block = ${gated} ? !existsSync(${JSON.stringify(seen)}) : !event.stop_hook_active;
      writeFileSync(${JSON.stringify(seen)}, "");
      process.stdout.write(JSON.stringify(block ? { decision: "block", reason: "verify it" } : {}));
    `);
    const hooksPath = join(scratch.path, "hooks.json");
    const hook = { type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, name: "Review" };
    writeFileSync(hooksPath, JSON.stringify({ hooks: { session_stop: [{ hooks: [hook] }] } }));
    return {
      hooks: GhostHookRunner.fromConfig(hooksPath),
      started,
      go,
      inputs: () => readFileSync(observed, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    };
  }

  it("runs `!command` in the owner home and hands its output to the next turn", async () => {
    const fake = harness(replies("seen"));
    const sessions = host({ fake: fake });
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

  it("bounds a newline-free owner command's output and preserves its actual trailing bytes", async () => {
    const sessions = host({ fake: harness([]) });
    await turn(sessions, "!printf '%0600000d' 0; printf tail");
    const entry = (await readLog(sessionDir(), "c1"))?.find((item) => item.type === "command");
    if (entry?.type !== "command") throw new Error("Owner command was not logged.");
    expect(entry.output).toHaveLength(100_000);
    expect(entry.output.endsWith("tail")).toBe(true);
    expect(entry.output).not.toContain("\n");
  });

  it("stops a running `!command`", async () => {
    const sessions = host({ fake: harness([]) });
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
    const sessions = host({ fake: harness(replies("on it")) });
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
    const sessions = host({ fake: harness([]) });
    await turn(sessions, "!printf '# Readme\\n```sh\\nls\\n```\\n'");
    const { messages } = await sessions.readTranscript("casper", "c1", {});
    expect(messages.at(-1)?.content).toEqual([{ type: "text", text: "````\n# Readme\n```sh\nls\n```\n````" }]);
  });

  it("hands a message that is only a photo to the harness, not to bash", async () => {
    const fake = harness(replies("a red bicycle"));
    const sessions = host({ fake: fake });
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
    const sessions = host({ fake: fake });
    await turn(sessions, "hello");
    await turn(sessions, "!!echo secret");
    await turn(sessions, "next");
    expect(fake.calls()[1]?.message).toBe("next");
  });

  it("continues the turn while a session_stop hook asks it to", async () => {
    const stop = recordingStopHook();
    const fake = harness(replies("done", "verified"));
    const sessions = host({ fake: fake, hooks: stop.hooks });
    const events = await turn(sessions, "do it");

    // Each run of the hook is bracketed by its name and event, so a client can
    // tell a stop hook, which runs after the reply is complete, from one the
    // reply waits on.
    const hookEvents = events.filter((event) => event.type === "hook_start" || event.type === "hook_end"
      || event.type === "session_stop_continued" || event.type === "done");
    expect(hookEvents).toEqual([
      { type: "hook_start", name: "Review", event: "session_stop" },
      { type: "hook_end", name: "Review", event: "session_stop" },
      { type: "session_stop_continued", reason: "verify it" },
      { type: "hook_start", name: "Review", event: "session_stop" },
      { type: "hook_end", name: "Review", event: "session_stop" },
      expect.objectContaining({ type: "done" }),
    ]);
    expect(fake.calls()[1]?.message).toBe("Stop hook feedback:\nverify it");
    expect((await sessions.readTranscript("casper", "c1")).messages.map((message) => message.role)).toEqual(["user", "assistant", "hook", "assistant"]);
    const [first, continued] = stop.inputs();
    expect(first).toMatchObject({ type: "session_stop", owner_prompt: "do it", turn_id: expect.any(String), stop_hook_active: false });
    expect(continued).toMatchObject({ type: "session_stop", owner_prompt: "do it", turn_id: first?.turn_id, stop_hook_active: true });
  });

  // `ghost ask` ends the turn on the owner: a stop hook's "keep going" must
  // not carry the ghost past its own question.
  it("runs no session_stop hook while the ghost's question waits on the owner", async () => {
    const stop = recordingStopHook();
    const fake = harness([]);
    const gate = fake.gate("asking");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "Write this as my character file?" }], gate: gate.path }, ...replies("written")]);
    const sessions = host({ fake: fake, hooks: stop.hooks });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "draft your character", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    // The ghost runs `ghost ask` during its pass.
    await sessions.setQuestion("casper", "c1", "Write this as my character file?", ["Write it", "Change something first"]);
    gate.release();
    await running;
    expect(fake.calls()).toHaveLength(1);
    expect(events.some((event) => event.type === "hook_start" && event.event === "session_stop")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("gives repeated identical owner requests distinct hook identities", async () => {
    const stop = recordingStopHook();
    const fake = harness(replies("done", "verified", "done again", "verified again"));
    const sessions = host({ fake: fake, hooks: stop.hooks });
    await turn(sessions, "do it");
    await turn(sessions, "do it");
    const ids = stop.inputs().map((input) => input.turn_id);
    expect(ids).toEqual([ids[0], ids[0], ids[2], ids[2]]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("does not ask the stop hook while the owner's follow-up waits", async () => {
    const stop = recordingStopHook(true);
    writeFileSync(stop.go, "");
    const fake = harness([]);
    const gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "first" }], gate: gate.path }, ...replies("second", "verified")]);
    const sessions = host({ fake: fake, hooks: stop.hooks });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    await sessions.queueMessage("casper", "c1", "two");
    gate.release();
    await running;

    // The first pass is not reviewed; the follow-up's own pass is.
    expect(fake.calls().map((call) => call.message)).toEqual(["one", "two", "Stop hook feedback:\nverify it"]);
    expect(events.findIndex((event) => event.type === "owner_message"))
      .toBeLessThan(events.findIndex((event) => event.type === "session_stop_continued"));
    const [reviewed, continued] = stop.inputs();
    expect(reviewed).toMatchObject({ type: "session_stop", owner_prompt: "two", turn_id: expect.any(String), stop_hook_active: false });
    expect(continued).toMatchObject({ type: "session_stop", owner_prompt: "two", turn_id: reviewed?.turn_id, stop_hook_active: true });
  });

  it("lets a follow-up sent while the stop hook runs win over its continuation", async () => {
    const stop = recordingStopHook(true);
    const fake = harness(replies("first", "second"));
    const sessions = host({ fake: fake, hooks: stop.hooks });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: (event) => events.push(event) });
    await waitFor(() => existsSync(stop.started));
    await sessions.queueMessage("casper", "c1", "two");
    writeFileSync(stop.go, "");
    await running;

    expect(fake.calls().map((call) => call.message)).toEqual(["one", "two"]);
    expect(events).toContainEqual({ type: "owner_message", text: "two" });
    expect(events.some((event) => event.type === "session_stop_continued")).toBe(false);
    const [first, reviewed] = stop.inputs();
    expect(first).toMatchObject({ owner_prompt: "one", turn_id: expect.any(String) });
    expect(reviewed).toMatchObject({ owner_prompt: "two", stop_hook_active: false });
    expect(reviewed?.turn_id).not.toBe(first?.turn_id);
  });
});

describe("conversation metadata", () => {
  it("keeps concurrent pin and read changes to different conversations", async () => {
    const sessions = host({ fake: harness(replies("one", "two")) });
    await turn(sessions, "first", "c1");
    await turn(sessions, "second", "c2");

    await Promise.all([
      sessions.setPinned("casper", "c1", true),
      sessions.setPinned("casper", "c2", true),
    ]);
    expect((await readPins(sessionDir())).sort()).toEqual(["c1", "c2"]);

    await Promise.all([
      sessions.markRead("casper", "c1"),
      sessions.markRead("casper", "c2"),
    ]);
    expect(Object.keys((await readReads(sessionDir()))).sort()).toEqual(["c1", "c2"]);
  });

  it("lists, titles, pins, reads, and trashes a conversation", async () => {
    const sessions = host({ fake: harness(replies("hi")) });
    await turn(sessions, "Plan the zine\nwith details");
    let [row] = await sessions.listSessions("casper");
    expect(row).toMatchObject({ id: "c1", title: "Plan the zine", preview: "Plan the zine", messageCount: 2, pinned: false, unread: true });

    await sessions.renameConversation("casper", "c1", "Zine");
    await sessions.setPinned("casper", "c1", true);
    await sessions.markRead("casper", "c1", new Date(Date.now() + 60_000));
    [row] = await sessions.listSessions("casper");
    expect(row).toMatchObject({ title: "Zine", pinned: true, unread: false });

    await sessions.deleteSession("casper", "c1");
    expect(existsSync(join(temp.trashDir, "files", basename(conversationDir(sessionDir(), "c1"))))).toBe(true);
    expect(existsSync(conversationDir(sessionDir(), "c1"))).toBe(false);
    expect(await sessions.listSessions("casper")).toEqual([]);
  });

  it("skips a torn last log line", async () => {
    const sessions = host({ fake: harness(replies("hi")) });
    await turn(sessions, "hello");
    const before = (await readLog(sessionDir(), "c1"))?.length;
    writeFileSync(logPath(sessionDir(), "c1"), `${readFileSync(logPath(sessionDir(), "c1"), "utf8")}{"type":"us`);
    expect((await readLog(sessionDir(), "c1"))?.length).toBe(before);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


describe("completion delivery", () => {
  function delivery(events: GhostHookEvent[], fail = false): GhostHookRunner {
    return new GhostHookRunner({
      commands: parseHooksDocument({ hooks: { turn_end: [{ hooks: [{ type: "command", command: "notify" }] }] } }, "test"),
      commandRunner: async (_hook, event) => {
        events.push(event);
        if (fail) throw new Error("delivery offline");
        return { exitCode: 0, stdout: '{"continue":true}', stderr: "", aborted: false, timedOut: false, overflowed: false, executionFailed: false };
      },
    });
  }
  it("delivers a final bounded excerpt and exact conversation link once after done", async () => {
    const notifications: GhostHookEvent[] = [];
    const fake = harness(replies(`Finished.\n${"a".repeat(400)}`));
    const sessions = host({ fake: fake, hooks: delivery(notifications), conversationUrl: async (ghost, id) => `https://summonghost.com/#/ghost.example.ts.net/${ghost}/${id}` });
    const events = await turn(sessions, "Make the report");
    await waitFor(() => notifications.length > 0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "turn_end", outcome: "done", title: "Make the report", url: "https://summonghost.com/#/ghost.example.ts.net/casper/c1" });
    expect(notifications[0]?.type === "turn_end" && notifications[0].excerpt.length).toBe(280);
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
    expect(events.filter(event => event.type === "hook_start")).toEqual([]);
    expect(events.at(-1)?.type).toBe("done");
    expect(fake.calls()).toHaveLength(1);
  });
  it("reports the turn id of the owner request the final pass answered", async () => {
    const seen: GhostHookEvent[] = [];
    const hooks = new GhostHookRunner({
      commands: parseHooksDocument({ hooks: {
        session_stop: [{ hooks: [{ type: "command", command: "record" }] }],
        turn_end: [{ hooks: [{ type: "command", command: "notify" }] }],
      } }, "test"),
      commandRunner: async (_hook, event) => {
        seen.push(event);
        return { exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false, overflowed: false, executionFailed: false };
      },
    });
    const fake = harness([]), gate = fake.gate("first");
    fake.setTurns([{ events: [{ type: "text", block: "a", delta: "first" }], gate: gate.path }, ...replies("second")]);
    const sessions = host({ fake: fake, hooks });
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "one", emit: () => {} });
    await waitFor(() => fake.calls().length === 1);
    await sessions.queueMessage("casper", "c1", "two");
    gate.release(); await running;
    await waitFor(() => seen.some(event => event.type === "turn_end"));
    const followUp = seen.find(event => event.type === "session_stop" && event.owner_prompt === "two");
    expect(seen.find(event => event.type === "turn_end")).toMatchObject({ turn_id: followUp?.turn_id, excerpt: "second" });
  });
  it("lets the owner prompt again while a slow notifier is still delivering", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), notifications: GhostHookEvent[] = [];
    const hooks = new GhostHookRunner({
      commands: parseHooksDocument({ hooks: { turn_end: [{ hooks: [{ type: "command", command: "notify" }] }] } }, "test"),
      commandRunner: async (_hook, event) => {
        notifications.push(event); await held;
        return { exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false, overflowed: false, executionFailed: false };
      },
    });
    const sessions = host({ fake: harness([...replies("One."), ...replies("Two.")]), hooks });
    await turn(sessions, "First");
    await waitFor(() => notifications.length === 1);
    expect((await turn(sessions, "Second")).at(-1)?.type).toBe("done");
    await waitFor(() => notifications.length === 2);
    release();
  });
  it("reports failed turns and fails open when the delivery service is unavailable", async () => {
    const notifications: GhostHookEvent[] = [];
    const sessions = host({ fake: harness([{ fail: "service unavailable" }]), hooks: delivery(notifications, true) });
    const events = await turn(sessions, "Try it");
    await waitFor(() => notifications.length > 0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "turn_end", outcome: "error", url: null });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
  it("keeps cancelled turns quiet", async () => {
    const notifications: GhostHookEvent[] = [], fake = harness([]);
    fake.setTurns([{ gate: fake.gate("never").path }]);
    const sessions = host({ fake: fake, hooks: delivery(notifications) });
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "wait", emit: event => events.push(event) });
    await waitFor(() => fake.calls().length === 1);
    sessions.stopTurn("casper", "c1"); await running;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(notifications).toEqual([]);
  });
  it("does no remote discovery when notification delivery is disabled", async () => {
    let lookups = 0;
    const sessions = host({ fake: harness(replies("done")), conversationUrl: async () => { lookups++; return null; } });
    await turn(sessions, "Do it");
    expect(lookups).toBe(0);
  });
  it("does not let a late read receipt move the read watermark backwards", async () => {
    const sessions = host({ fake: harness(replies("done")) });
    await turn(sessions, "Do it");
    const latest = new Date(); await sessions.markRead("casper", "c1", latest);
    await sessions.markRead("casper", "c1", new Date(0));
    expect((await readReads(sessionDir())).c1).toBe(latest.toISOString());
  });
});
