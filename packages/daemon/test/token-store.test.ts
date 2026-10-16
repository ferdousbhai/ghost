import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiTokenCommand, apiTokenPath, ensureApiToken, readApiToken, TOKEN_PATTERN } from "../src/token-store.js";

const execFileAsync = promisify(execFile);

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ghost-api-token-"));
  path = join(dir, "state", "api-token");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the API token file", () => {
  it("lives under XDG state unless named explicitly", () => {
    expect(apiTokenPath({ XDG_STATE_HOME: "/xdg/state" }, "/home/x")).toBe("/xdg/state/ghost/api-token");
    expect(apiTokenPath({ XDG_STATE_HOME: "relative" }, "/home/x")).toBe("/home/x/.local/state/ghost/api-token");
    expect(apiTokenPath({ GHOSTD_API_TOKEN_FILE: "/tmp/t" }, "/home/x")).toBe("/tmp/t");
  });

  it("is minted once, owner-only, and read back the same ever after", async () => {
    expect(readApiToken(path)).toBeUndefined();
    const first = ensureApiToken(path);
    expect(first).toMatchObject({ created: true, token: expect.stringMatching(TOKEN_PATTERN) });
    expect(ensureApiToken(path)).toEqual({ token: first.token, created: false });
    expect(readApiToken(path)).toBe(first.token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "state"))).toEqual(["api-token"]);
  });

  it("refuses a link, a readable-by-others file, and a malformed one instead of replacing it", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(join(dir, "real"), `${"a".repeat(64)}\n`, { mode: 0o600 });
    await symlink(join(dir, "real"), path);
    expect(() => ensureApiToken(path)).toThrow();
    await rm(path);
    await writeFile(path, `${"a".repeat(64)}\n`, { mode: 0o644 });
    expect(() => ensureApiToken(path)).toThrow(/mode 0600/);
    await rm(path);
    await writeFile(path, `${"A".repeat(64)}\n`, { mode: 0o600 });
    expect(() => ensureApiToken(path)).toThrow(/malformed/);
  });

  it("gives every process that mints at once the one winning token", async () => {
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `const { ensureApiToken } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify(ensureApiToken(${JSON.stringify(path)})));`;
    const results = await Promise.all(Array.from({ length: 12 }, async () =>
      JSON.parse((await execFileAsync(process.execPath, ["--eval", script])).stdout) as { token: string; created: boolean }));
    expect(new Set([...results.map((result) => result.token), readApiToken(path)]).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });
});

describe("ghostd api-token", () => {
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = apiTokenCommand(argv, { path, stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    return { code, out: out.join(""), err: err.join("") };
  };

  it("mints, prints, and says where it lives and how to replace it", () => {
    const { code, out } = run([]);
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toMatch(TOKEN_PATTERN);
    expect(out).toContain(path);
    expect(out).toContain("delete the file and restart ghostd");
  });

  it("prints only the token under --quiet, so it can be piped into curl", () => {
    expect(run(["--quiet"]).out).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it("refuses an option it does not know, --rotate included", () => {
    expect(run(["--rotate"])).toMatchObject({ code: 2, err: "api-token: unknown option --rotate\n" });
  });
});
