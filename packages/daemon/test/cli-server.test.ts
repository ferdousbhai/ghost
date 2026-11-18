import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListeningServer } from "../src/server.js";
import type { SessionHost } from "../src/session-host.js";
import { runCli } from "./helpers/cli.js";
import { startTestDaemon, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse } from "./helpers/http-fetch.js";
import type { FakeHarness } from "./helpers/fake-harness.js";

const API_TOKEN = "a".repeat(64);
let temp: TempGhosts;
let harness: FakeHarness;
let host: SessionHost;
let listening: ListeningServer | null;
let tokenFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  const fixture = await startTestDaemon({
    ghost: "casper",
    openSession: "conv-1",
  });
  ({ temp, harness, host, listening, tokenFile, env } = fixture);
});

afterEach(async () => {
  await listening?.close();
  await host.disposeAll();
  harness.cleanup();
  temp.cleanup();
});

async function cli(argv: string[], overrides: { env?: NodeJS.ProcessEnv } = {}) {
  return runCli(argv, {
    env: overrides.env ?? env,
    home: temp.ownerHome,
    fetch: fetchNoReuse,
  });
}

describe("ghost CLI against a real daemon server", () => {
  it("lists, creates, and persists a validated default mode 0600", async () => {
    const listed = await cli(["list", "--json"]);
    expect(listed).toMatchObject({ code: 0 });
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ name: "casper" })]);

    expect(await cli(["new", "probe", "--json"])).toMatchObject({ code: 0 });
    const used = await cli(["use", "casper"]);
    expect(used).toMatchObject({ code: 0, stdout: "Default ghost is now casper.\n" });
    const path = join(env.XDG_CONFIG_HOME!, "ghost", "cli.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ghost: "casper" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await cli(["use", "--json"])).stdout)).toEqual({ ghost: "casper" });
    expect(await cli(["use", "nobody"])).toMatchObject({ code: 5, stderr: expect.stringContaining('ghost "nobody" was not found') });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ghost: "casper" });

    const defaultSessions = await cli(["sessions", "--json"]);
    expect(defaultSessions).toMatchObject({ code: 0 });
    expect(JSON.parse(defaultSessions.stdout).sessions).toEqual([
      expect.objectContaining({ id: "conv-1", harness: "fake" }),
    ]);
  });

  it("lists sessions and reports status", async () => {
    const sessions = await cli(["sessions", "-g", "casper", "--json"]);
    expect(sessions.code).toBe(0);
    expect(JSON.parse(sessions.stdout).sessions).toEqual([
      expect.objectContaining({ id: "conv-1", harness: "fake" }),
    ]);

    const status = await cli(["status", "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      daemon: `http://127.0.0.1:${listening!.port}`,
      tokenFile,
      version: expect.any(String),
    });
  });

  it("reaches ghost admin and conversation state through named verbs", async () => {
    const shown = await cli(["character", "-g", "casper"]);
    expect(shown.code).toBe(0);
    const file = join(env.XDG_CONFIG_HOME!, "character.md");
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    writeFileSync(file, "# Casper\n\nA quiet ghost.\n");
    expect(await cli(["character", "set", file, "-g", "casper", "--json"])).toMatchObject({ code: 0 });
    expect((await cli(["character", "-g", "casper"])).stdout).toContain("A quiet ghost.");

    const read = await cli(["read", "-g", "casper", "-s", "conv", "--json"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ ok: true });
    expect(await cli(["remote"])).toMatchObject({ code: 0, stdout: "off\n" });
    expect(await cli(["browser"])).toMatchObject({ code: 2 });
    expect(await cli(["browser", "allow"])).toMatchObject({ code: 2 });
  });

  it("acknowledges an MCP change in one sentence and lists the table only for list", async () => {
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    const file = join(env.XDG_CONFIG_HOME!, "notes.json");
    writeFileSync(file, JSON.stringify({ command: "/usr/bin/notes-mcp" }));
    expect(await cli(["mcp", "add", "notes", file])).toMatchObject({ code: 0, stdout: "Added notes, disabled until `ghost mcp enable notes`.\n" });
    expect(await cli(["mcp", "enable", "notes"])).toMatchObject({ code: 0, stdout: "Enabled notes.\n" });
    expect(await cli(["mcp", "set", "notes", file, "-q"])).toMatchObject({ code: 0, stdout: "" });
    const listed = await cli(["mcp"]);
    expect(listed.stdout).toContain("SERVER");
    expect(listed.stdout).toContain("notes");
    const disabled = await cli(["mcp", "disable", "notes", "--json"]);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ servers: [expect.objectContaining({ name: "notes", enabled: false })] });
    expect(await cli(["mcp", "rm", "notes"])).toMatchObject({ code: 0, stdout: "Removed notes.\n" });
  });

  it("shows and sets the agent a ghost prefers, and switches a conversation", async () => {
    const shown = await cli(["harness", "-g", "casper"]);
    expect(shown).toMatchObject({ code: 0 });
    expect(shown.stdout).toBe("casper runs on automatic (now fake)\n");
    expect(await cli(["harness", "fake", "-g", "casper", "-q"])).toMatchObject({ code: 0 });
    expect((await cli(["harness", "-g", "casper"])).stdout).toContain("casper runs on fake");
    expect(await cli(["harness", "--none", "-g", "casper", "-q"])).toMatchObject({ code: 0 });
    expect(await cli(["harness", "fake", "--none", "-g", "casper"])).toMatchObject({ code: 2 });
    expect(await cli(["harness", "nope", "-g", "casper"])).not.toMatchObject({ code: 0 });

    // From a ghost's own shell, the conversation is $GHOST_SESSION.
    const switched = await cli(["switch", "fake"], { env: { ...env, GHOST: "casper", GHOST_SESSION: "conv-1" } });
    expect(switched).toMatchObject({ code: 0, stdout: "Conversation conv-1 now runs on fake.\n" });
    // A prefix names the listed conversation, as -s does elsewhere, not a new one.
    expect(await cli(["switch", "fake", "-g", "casper", "-s", "conv"]))
      .toMatchObject({ code: 0, stdout: "Conversation conv-1 now runs on fake.\n" });
    // One no message has landed in yet is addressed as given.
    expect(await cli(["switch", "fake", "-g", "casper", "-s", "fresh-1"]))
      .toMatchObject({ code: 0, stdout: "Conversation fresh-1 now runs on fake.\n" });
    // and `say` reaches the same unlisted conversation `switch` just named.
    const said = await cli(["say", "-g", "casper", "-s", "fresh-1", "-q", "hi"]);
    expect(said.code, said.stderr).toBe(0);
    expect((await host.listSessions("casper")).map((row) => row.id)).toContain("fresh-1");
  });

  it("moves the `ghost use` default with a rename and clears it with removal", async () => {
    const path = join(env.XDG_CONFIG_HOME!, "ghost", "cli.json");
    expect(await cli(["new", "probe", "-q"])).toMatchObject({ code: 0 });
    expect(await cli(["use", "casper", "-q"])).toMatchObject({ code: 0 });
    // Another ghost's rename or removal leaves it alone.
    expect(await cli(["rename", "spook", "-g", "probe", "-q"])).toMatchObject({ code: 0 });
    expect(await cli(["rm", "spook", "--yes", "-q"])).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ghost: "casper" });

    expect(await cli(["rename", "wisp", "-g", "casper", "-q"])).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ghost: "wisp" });
    expect(JSON.parse((await cli(["sessions", "--json"])).stdout).sessions).toEqual([expect.objectContaining({ id: "conv-1" })]);

    expect(await cli(["rm", "wisp", "--yes", "-q"])).toMatchObject({ code: 0 });
    expect(existsSync(path)).toBe(false);
    expect(await cli(["use"])).toMatchObject({ code: 0, stdout: "No default ghost.\n" });
    expect(await cli(["use", "-q"])).toMatchObject({ code: 0, stdout: "" });
    expect(JSON.parse((await cli(["use", "--json"])).stdout)).toEqual({ ghost: null });

    // The way out: `--none` forgets a default without removing a ghost.
    expect(await cli(["new", "keeper", "-q"])).toMatchObject({ code: 0 });
    expect(await cli(["use", "keeper", "-q"])).toMatchObject({ code: 0 });
    expect(await cli(["use", "keeper", "--none"])).toMatchObject({ code: 2 });
    expect(await cli(["use", "--none"])).toMatchObject({ code: 0, stdout: "No default ghost.\n" });
    expect(existsSync(path)).toBe(false);
    expect(await cli(["use", "--none", "-q"])).toMatchObject({ code: 0, stdout: "" });
  });

  it("keeps destructive removal behind --yes", async () => {
    const result = await cli(["rm", "casper"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires --yes");
    expect(temp.registry.get("casper").name).toBe("casper");
  });

  it("refuses a flag on a verb that does not take it", async () => {
    const result = await cli(["list", "--keep"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("keep");
  });

  it("maps a wrong token to exit 4 with the owner hint", async () => {
    writeFileSync(tokenFile, `${"b".repeat(64)}\n`, { mode: 0o600 });
    const result = await cli(["status"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("ghostd api-token");
    expect(result.stderr).toContain(tokenFile);
  });

  it("re-reads a rotated token once after a 401", async () => {
    writeFileSync(tokenFile, `${"b".repeat(64)}\n`, { mode: 0o600 });
    let calls = 0;
    const retryingFetch: typeof fetchNoReuse = async (input, init) => {
      calls += 1;
      const response = await fetchNoReuse(input, init);
      if (response.status === 401) writeFileSync(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
      return response;
    };
    const result = await runCli(["list", "--json"], {
      env,
      home: temp.ownerHome,
      fetch: retryingFetch,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(calls).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ name: "casper" })]);
  });

  it("maps a closed daemon to exit 3", async () => {
    const port = listening!.port;
    await listening!.close();
    listening = null;
    const result = await cli(["status"], { env: { ...env, GHOSTD_PORT: String(port) } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("cannot reach ghostd");
  });

});

