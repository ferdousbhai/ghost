import { isAbsolute } from "node:path";
import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { NativeHarnessExecutable } from "./native-harness-identity.js";

const SCRIPT_SUFFIXES = [".js", ".mjs", ".tsx", ".ts", ".jsx"] as const;

export interface ClaudeSdkScriptLaunch {
  readonly command: "bun";
  readonly executable: string;
  readonly prefixArguments: readonly [string];
}

export function isClaudeSdkScriptExecutable(path: string): boolean {
  return SCRIPT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** The pinned SDK's exact lowercase JavaScript/TypeScript executable transform. */
export function claudeSdkScriptLaunch(path: string): ClaudeSdkScriptLaunch | undefined {
  if (!isClaudeSdkScriptExecutable(path)) return undefined;
  if (!(process.versions as NodeJS.ProcessVersions & { bun?: string }).bun
    || !isAbsolute(process.execPath)) {
    throw new Error("Claude script wrappers require Ghost's exact Bun runtime.");
  }
  return Object.freeze({
    command: "bun",
    executable: process.execPath,
    prefixArguments: Object.freeze([path] as const),
  });
}

export function claudeSdkSpawnLaunch(
  executable: NativeHarnessExecutable,
  interpreter: NativeHarnessExecutable | undefined,
  options: ClaudeSpawnOptions,
  cwd: string,
): Readonly<{ executable: string; args: readonly string[] }> {
  if (options.cwd !== cwd) throw new Error("Claude spawn cwd changed.");
  const script = claudeSdkScriptLaunch(executable.path);
  if (!script) {
    if (interpreter !== undefined || options.command !== executable.path) {
      throw new Error("Claude spawn executable changed.");
    }
    return Object.freeze({ executable: executable.path, args: Object.freeze([...options.args]) });
  }
  if (options.command !== script.command
    || options.args[0] !== executable.path
    || interpreter?.path !== script.executable) {
    throw new Error("Claude script spawn transform changed.");
  }
  return Object.freeze({ executable: interpreter.path, args: Object.freeze([...options.args]) });
}
