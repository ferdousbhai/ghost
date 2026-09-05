import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectNativeHarnessExecutable,
  inspectNativeHarnessExecutableSync,
  resolveNativeHarnessExecutable,
  type NativeHarnessId,
} from "../src/native-harness-identity.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ghost-native-identity-test-"));
  roots.push(path);
  return path;
}

function writeExecutable(path: string, body = "exit 0"): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
}

describe("native harness executable identity", () => {
  it.each<{
    harness: NativeHarnessId;
    binaryName: "claude" | "codex" | "pi";
  }>([
    { harness: "claude-code", binaryName: "claude" },
    { harness: "codex", binaryName: "codex" },
    { harness: "pi", binaryName: "pi" },
  ])("canonicalizes default $binaryName independently of a later cwd", async ({
    harness,
    binaryName,
  }) => {
    const base = root();
    const initialCwd = join(base, "initial");
    const laterCwd = join(base, "later");
    const initialBin = join(initialCwd, "bin");
    const laterBin = join(laterCwd, "bin");
    mkdirSync(initialBin, { recursive: true });
    mkdirSync(laterBin, { recursive: true });
    const executable = join(initialBin, binaryName);
    const laterExecutable = join(laterBin, binaryName);
    const probe = join(base, "resolve.ts");
    writeExecutable(executable);
    writeExecutable(laterExecutable, "exit 23");
    writeFileSync(probe, [
      `import { resolveNativeHarnessExecutable } from ${JSON.stringify(new URL("../src/native-harness-identity.ts", import.meta.url).href)};`,
      `const result = await resolveNativeHarnessExecutable({ harness: ${JSON.stringify(harness)}, environment: { PATH: "bin" }, timeoutMs: 1_000 });`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"));
    const result = JSON.parse(execFileSync(process.execPath, [probe], {
      cwd: initialCwd,
      encoding: "utf8",
    })) as Awaited<ReturnType<typeof resolveNativeHarnessExecutable>>;

    expect(result.path).toBe(executable);
    expect(result.literalBoundary).toBe(false);
    expect(resolve(laterCwd, "bin", binaryName)).toBe(laterExecutable);
    expect(resolve(laterCwd, "bin", binaryName)).not.toBe(result.path);
    expect(await inspectNativeHarnessExecutable(result.path, false)).toBe(result.identity);
  });

  it("unwraps only default mise launchers and honors an explicit wrapper literally", async () => {
    const base = root();
    const bin = join(base, "bin");
    mkdirSync(bin);
    const wrapper = join(bin, "codex");
    const mise = join(bin, "mise");
    const target = join(base, "codex-native");
    writeExecutable(wrapper, "exec mise x codex \"$@\"");
    writeExecutable(mise, "[ \"$1\" = which ] && printf '%s\\n' \"$MISE_TARGET\"");
    writeExecutable(target);
    const environment = { PATH: bin, MISE_TARGET: target };

    const discovered = await resolveNativeHarnessExecutable({
      harness: "codex",
      environment,
      timeoutMs: 1_000,
    });
    const explicit = await resolveNativeHarnessExecutable({
      harness: "codex",
      explicitBinary: "codex",
      environment,
      timeoutMs: 1_000,
    });

    expect(discovered).toMatchObject({ path: target, literalBoundary: false });
    expect(explicit).toMatchObject({ path: wrapper, literalBoundary: true });
  });

  it("unwraps a mise shim that is a symlink to the mise binary", async () => {
    const base = root();
    const bin = join(base, "bin");
    const shims = join(base, "shims");
    mkdirSync(bin);
    mkdirSync(shims);
    const mise = join(bin, "mise");
    const target = join(base, "claude-native");
    writeExecutable(mise, "[ \"$1\" = which ] && printf '%s\\n' \"$MISE_TARGET\"");
    writeExecutable(target);
    symlinkSync(mise, join(shims, "claude"));
    const environment = { PATH: `${shims}:${bin}`, MISE_TARGET: target };

    const discovered = await resolveNativeHarnessExecutable({
      harness: "claude-code",
      environment,
      timeoutMs: 1_000,
    });
    expect(discovered).toMatchObject({ path: target, literalBoundary: false });
  });

  it("detects symlink retargeting and in-place literal-wrapper replacement", async () => {
    const base = root();
    const first = join(base, "first");
    const second = join(base, "second");
    const wrapper = join(base, "wrapper");
    writeExecutable(first, "exit 0");
    writeExecutable(second, "exit 1");
    symlinkSync(first, wrapper);

    const before = await inspectNativeHarnessExecutable(wrapper, true);
    expect(inspectNativeHarnessExecutableSync(wrapper, true)).toBe(before);
    unlinkSync(wrapper);
    symlinkSync(second, wrapper);
    const retargeted = await inspectNativeHarnessExecutable(wrapper, true);
    expect(retargeted).not.toBe(before);

    unlinkSync(wrapper);
    writeExecutable(wrapper, "exit 0");
    const written = await inspectNativeHarnessExecutable(wrapper, true);
    writeExecutable(wrapper, "printf changed");
    const replaced = await inspectNativeHarnessExecutable(wrapper, true);
    expect(replaced).not.toBe(written);
  });
});
