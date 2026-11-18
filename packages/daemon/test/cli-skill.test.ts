import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { tempDir } from "./helpers/fixtures.js";

const SHIPPED = readFileSync(new URL("../../../skills/ghost/SKILL.md", import.meta.url), "utf8");

let home: { path: string; cleanup(): void } | undefined;
afterEach(() => home?.cleanup());

describe("ghost skill", () => {
  it("prints the skill this ghost shipped with", async () => {
    home = tempDir();
    const result = await runCli(["skill"], { env: {}, home: home.path });
    expect(result).toMatchObject({ code: 0, stdout: SHIPPED });
  });

  it("installs it for the owner's agents, linking Claude Code's copy, and removes only what it made", async () => {
    home = tempDir();
    mkdirSync(join(home.path, ".claude"));
    const agents = join(home.path, ".agents", "skills", "ghost");
    const claude = join(home.path, ".claude", "skills", "ghost");

    expect((await runCli(["skill", "install"], { env: {}, home: home.path })).code).toBe(0);
    expect(readFileSync(join(agents, "SKILL.md"), "utf8")).toBe(SHIPPED);
    expect(lstatSync(claude).isSymbolicLink() && readlinkSync(claude)).toBe(agents);
    // A second install leaves the link as it was.
    expect((await runCli(["skill", "install"], { env: {}, home: home.path })).code).toBe(0);

    expect((await runCli(["skill", "remove"], { env: {}, home: home.path })).code).toBe(0);
    expect(existsSync(agents)).toBe(false);
    expect(existsSync(claude)).toBe(false);
    expect(existsSync(join(home.path, ".claude"))).toBe(true);
  });

  it("refuses an action it does not know", async () => {
    home = tempDir();
    expect(await runCli(["skill", "bogus"], { env: {}, home: home.path })).toMatchObject({ code: 2, stderr: expect.stringContaining("install or remove") });
  });
});
