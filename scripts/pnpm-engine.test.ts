import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("prepare-pnpm-engine accepts the packageManager pnpm and rejects another version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ghost-pnpm-engine-"));
  try {
    await writeFile(join(dir, "pnpm"), `#!/bin/sh
[ "$1" = --version ] || exit 9
printf '%s\\n' "\${TEST_PNPM_VERSION}"
`);
    await chmod(join(dir, "pnpm"), 0o755);
    await writeFile(join(dir, "package.json"), '{"packageManager":"pnpm@10.12.2"}');
    const run = (version: string) => exec("bash", [new URL("../packaging/release/prepare-pnpm-engine.sh", import.meta.url).pathname, dir], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_PNPM_VERSION: version },
    });
    expect((await run("10.12.2")).stdout).toContain("pnpm 10.12.2 matches packageManager");
    await expect(run("12.13.0")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ghost requires pnpm 10.12.2, resolved 12.13.0") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
