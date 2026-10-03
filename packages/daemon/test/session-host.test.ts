/**
 * The session host over a scripted harness: what a turn hands the harness
 * (persona, cwd, env, resume, MCP), what it streams back, what the
 * conversation log keeps, and how it chooses and falls back between harnesses.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationDir, logPath, readLog } from "../src/conversation-log.js";
import { ghostPaths } from "../src/ghosts.js";
import { GhostHookRunner } from "../src/hooks.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
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
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
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
    expect(transcript.harness).toBe("fake");
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
  });

  it("names a quota refusal when no harness is left", async () => {
    const spent = harness([{ exit: 1, stderr: "You've hit your usage limit." }], "only");
    const sessions = host({ harnesses: [spent] });
    const events = await turn(sessions, "hello");

    expect(events).toContainEqual({ type: "limit_reached", harness: "only", kind: "usage_limit", message: "You've hit your usage limit." });
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
    await turn(sessions, "Who are you?");
    await sessions.renameGhost("casper", "wisp");
    const events: TurnEvent[] = [];
    await sessions.runTurn("wisp", { sessionId: "c1", prompt: "And now?", emit: (event) => events.push(event) });

    const second = fake.calls()[1];
    expect(second?.resume).toBe(false);
    expect(second?.cwd).toBe(conversationDir(ghostPaths(join(temp.root, "wisp")).sessionDir, "c1"));
    expect(second?.prompt).toContain("Owner: Who are you?");
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
    await sessions.queueMessage("casper", "c1", "steer", "two");
    gate.release();
    await running;

    expect(events).toContainEqual({ type: "owner_message", text: "two" });
    expect(text(events)).toBe("firstsecond");
    expect(fake.calls().map((call) => [call.prompt, call.resume])).toEqual([["one", false], ["two", true]]);
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
  });

  it("refuses a queued message when nothing is streaming", async () => {
    const sessions = host({ harnesses: [harness(replies("x"))] });
    await expect(sessions.queueMessage("casper", "c1", "followUp", "late")).rejects.toMatchObject({ code: "session_not_streaming" });
  });

  it("kills the harness on abort and ends the turn aborted", async () => {
    const fake = harness([]);
    fake.setTurns([{ gate: fake.gate("never").path }]);
    const sessions = host({ harnesses: [fake] });
    const controller = new AbortController();
    const events: TurnEvent[] = [];
    const running = sessions.runTurn("casper", { sessionId: "c1", prompt: "wait", emit: (event) => events.push(event), signal: controller.signal });
    await waitFor(() => fake.calls().length === 1);
    controller.abort();
    await running;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });
});

describe("owner commands and hooks", () => {
  it("runs `!command` in the owner home and hands its output to the next turn", async () => {
    const fake = harness(replies("seen"));
    const sessions = host({ harnesses: [fake] });
    const events = await turn(sessions, "!echo printed-$GHOST_SESSION");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "bash", isError: false }));
    expect(fake.calls()).toEqual([]);

    await turn(sessions, "what did I run?");
    const [call] = fake.calls();
    expect(call?.prompt).toContain("Owner ran `echo printed-$GHOST_SESSION`");
    expect(call?.prompt).toContain("printed-c1");
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
    const scratch = tempDir();
    cleanups.push(scratch.cleanup);
    const script = join(scratch.path, "stop.sh");
    const marker = join(scratch.path, "seen");
    writeFileSync(script, `#!/bin/bash\nif [ -e ${marker} ]; then echo '{}'; else touch ${marker}; echo '{"decision":"block","reason":"verify it"}'; fi\n`);
    chmodSync(script, 0o755);
    const hooksPath = join(scratch.path, "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({ hooks: { session_stop: [{ hooks: [{ type: "command", command: script }] }] } }));
    const fake = harness(replies("done", "verified"));
    const sessions = host({ harnesses: [fake], hooks: GhostHookRunner.fromConfig(hooksPath) });
    const events = await turn(sessions, "do it");

    expect(events).toContainEqual({ type: "session_stop_continued", reason: "verify it" });
    expect(fake.calls()[1]?.prompt).toBe("Stop hook feedback:\nverify it");
    expect((await sessions.readTranscript("casper", "c1")).messages.map((message) => message.role)).toEqual(["user", "assistant", "hook", "assistant"]);
  });
});

describe("conversation metadata", () => {
  it("lists, titles, pins, reads, and trashes a conversation", async () => {
    const sessions = host({ harnesses: [harness(replies("hi"))] });
    await turn(sessions, "Plan the zine\nwith details");
    let [row] = await sessions.listSessions("casper");
    expect(row).toMatchObject({ id: "c1", title: null, preview: "Plan the zine", messageCount: 2, pinned: false, unread: true });

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

  it("accepts a legacy `pi:` id as the bare id", async () => {
    const sessions = host({ harnesses: [harness(replies("hi"))] });
    await turn(sessions, "hello", "pi:c1");
    expect((await sessions.listSessions("casper"))[0]?.id).toBe("c1");
  });

  it("skips a torn last log line", async () => {
    const sessions = host({ harnesses: [harness(replies("hi"))] });
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
