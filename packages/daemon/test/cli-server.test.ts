import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListeningServer } from "../src/server.js";
import type { SessionHost } from "../src/session-host.js";
import { runCli } from "./helpers/cli.js";
import { startTestDaemon, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse } from "./helpers/http-fetch.js";
import type { FakeAnswerer } from "./helpers/fake-answerer.js";

const API_TOKEN = "a".repeat(64);
let temp: TempGhosts;
let harness: FakeAnswerer;
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
  it("addresses the machine's one ghost with no flag", async () => {
    const sessions = await cli(["sessions", "--json"]);
    expect(sessions).toMatchObject({ code: 0 });
    expect(JSON.parse(sessions.stdout).sessions).toEqual([
      expect.objectContaining({ id: "conv-1" }),
    ]);
    expect(await cli(["sessions", "-q"], { env: { ...env } })).toMatchObject({ code: 0, stdout: "conv-1\n" });
    for (const verb of [["list"], ["new", "probe"], ["use", "casper"], ["rename", "wisp"]]) {
      expect(await cli(verb), verb.join(" ")).toMatchObject({ code: 2, stderr: expect.stringContaining("Unknown command") });
    }
    expect(await cli(["sessions", "--ghost", "casper"])).toMatchObject({ code: 2, stderr: expect.stringContaining("Unknown option") });
  });

  it("lists sessions and reports status", async () => {
    const sessions = await cli(["sessions", "--json"]);
    expect(sessions.code).toBe(0);
    expect(JSON.parse(sessions.stdout).sessions).toEqual([
      expect.objectContaining({ id: "conv-1" }),
    ]);

    const status = await cli(["status", "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      daemon: `http://127.0.0.1:${listening!.port}`,
      tokenFile,
      ghost: "casper",
      version: expect.any(String),
    });
  });

  it("reaches ghost admin and conversation state through named verbs", async () => {
    const shown = await cli(["character"]);
    expect(shown.code).toBe(0);
    const file = join(env.XDG_CONFIG_HOME!, "character.md");
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    writeFileSync(file, "# Casper\n\nA quiet ghost.\n");
    expect(await cli(["character", "set", file, "--json"])).toMatchObject({ code: 0 });
    expect((await cli(["character"])).stdout).toContain("A quiet ghost.");

    const read = await cli(["read", "-s", "conv", "--json"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ ok: true });
    expect(await cli(["remote"])).toMatchObject({ code: 0, stdout: "off\n" });
    expect(await cli(["browser"])).toMatchObject({ code: 2 });
    expect(await cli(["browser", "allow"])).toMatchObject({ code: 2 });
  });

  it("says into a conversation no message has landed in yet, addressed as given", async () => {
    const said = await cli(["say", "-s", "fresh-1", "-q", "hi"]);
    expect(said.code, said.stderr).toBe(0);
    expect((await host.listSessions()).map((row) => row.id)).toContain("fresh-1");
  });

  it("trashes a conversation only when named with -s, behind --yes", async () => {
    expect(await cli(["rm", "-s", "conv-1"])).toMatchObject({ code: 2, stderr: expect.stringContaining("requires --yes") });
    expect(await cli(["rm", "--yes"])).toMatchObject({ code: 2, stderr: expect.stringContaining("needs -s <id>") });
    expect(await cli(["rm", "casper", "--yes"])).toMatchObject({ code: 2 });
    expect((await host.listSessions()).map((row) => row.id)).toEqual(["conv-1"]);
    expect(await cli(["rm", "-s", "conv-1", "--yes"])).toMatchObject({ code: 0, stdout: "Trashed conv-1.\n" });
    expect(await host.listSessions()).toEqual([]);
    expect(temp.ghost.name).toBe("casper");
  });

  it("refuses a flag on a verb that does not take it", async () => {
    const result = await cli(["sessions", "--keep"]);
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
    const result = await runCli(["sessions", "-q"], {
      env: { ...env },
      home: temp.ownerHome,
      fetch: retryingFetch,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(calls).toBe(2);
    expect(result.stdout).toBe("conv-1\n");
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

