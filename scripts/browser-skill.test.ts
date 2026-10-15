import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("shared owner session selects and acts atomically, and missing tabs fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ghost-browser-skill-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const stub = join(bin, "agent-browser");
    await writeFile(stub, `#!/bin/bash
set -eu
[[ ! -e /proc/$$/fd/9 ]]
[[ "$1 $2 $3 $4 $5" == "--session owner --cdp 9222 --pin-tab" ]]
shift 5
if [[ "$1" == tab ]]; then
  [[ "$2" != missing ]] || exit 7
  printf '%s' "$2" > "$XDG_RUNTIME_DIR/active"
  sleep 0.01
else
  sleep 0.01
  printf '%s:%s\\n' "$BROWSER_TAB" "$(cat "$XDG_RUNTIME_DIR/active")" >> "$XDG_RUNTIME_DIR/actions"
fi
`);
    await chmod(stub, 0o755);
    const skill = await readFile(new URL("../skills/web-browser/SKILL.md", import.meta.url), "utf8");
    const recipe = /```sh\n([\s\S]+?)\n```/.exec(skill)?.[1];
    expect(recipe).toBeDefined();
    const run = (tab: string) => exec("bash", ["-c", `${recipe}\nexport BROWSER_TAB="$TEST_TAB"\nfor i in {1..5}; do browser fill '#email' "$TEST_TAB" || exit; done`], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: dir, TEST_TAB: tab },
    });
    await Promise.all([run("a"), run("b")]);
    const lines = (await readFile(join(dir, "actions"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => line === "a:a" || line === "b:b")).toBe(true);
    await expect(run("missing")).rejects.toMatchObject({ code: 7 });
    expect((await readFile(join(dir, "actions"), "utf8")).trim().split("\n")).toHaveLength(10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
