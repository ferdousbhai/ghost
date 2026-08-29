#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArgsError } from "./args.js";
import { askCommand } from "./ask.js";
import { CliError, DaemonClient } from "./client.js";
import { ghostsCommand } from "./ghosts.js";
import { memoryCommand } from "./memory.js";
import { modelCommand } from "./model.js";
import { sayCommand } from "./say.js";
import { sessionActionCommand, sessionsCommand, showCommand } from "./sessions.js";
import { skillCommand } from "./skill.js";
import { smokeCommand } from "./smoke.js";
import { statusCommand } from "./status.js";
import type { CliRuntime, GhostCliOptions } from "./types.js";
import { EXIT_CODES, commandHelp, USAGE } from "./usage.js";
import { watchCommand } from "./watch.js";
import { jobsCommand, planCommand, todoCommand } from "./work.js";

function version(runtime: Pick<CliRuntime, "env">): string {
  if (process.env.GHOSTD_VERSION?.trim()) return process.env.GHOSTD_VERSION.trim();
  if (runtime.env.GHOSTD_VERSION?.trim()) return runtime.env.GHOSTD_VERSION.trim();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function runtimeOptions(options: GhostCliOptions): CliRuntime {
  return {
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    fetch: options.fetch ?? globalThis.fetch,
    stdin: options.stdin ?? process.stdin,
  };
}

async function dispatch(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const verb = argv[0];
  if (!verb || verb === "--help" || verb === "-h") {
    runtime.stdout.write(USAGE);
    return 0;
  }
  if (verb === "--version" || verb === "-v") {
    runtime.stdout.write(`${version(runtime)}\n`);
    return 0;
  }
  if (verb === "help") {
    if (argv.length > 2) throw new ArgsError("Usage: ghost help [command|exit-codes]");
    const topic = argv[1];
    runtime.stdout.write(topic === "exit-codes" ? EXIT_CODES : topic ? commandHelp(topic) : USAGE);
    return 0;
  }
  if (verb === "skill") return skillCommand(argv.slice(1), runtime);
  if (verb === "smoke") return smokeCommand(argv.slice(1), runtime);

  const client = new DaemonClient(runtime);
  switch (verb) {
    case "say": return sayCommand(argv.slice(1), client, runtime);
    case "list":
    case "new":
    case "rm":
    case "use": return ghostsCommand(verb, argv.slice(1), client, runtime);
    case "sessions": return sessionsCommand(argv.slice(1), client, runtime);
    case "show": return showCommand(argv.slice(1), client, runtime);
    case "title":
    case "fork":
    case "pin":
    case "unpin": return sessionActionCommand(verb, argv.slice(1), client, runtime);
    case "ask": return askCommand(argv.slice(1), client, runtime);
    case "jobs": return jobsCommand(argv.slice(1), client, runtime);
    case "plan": return planCommand(argv.slice(1), client, runtime);
    case "todo": return todoCommand(argv.slice(1), client, runtime);
    case "model": return modelCommand(argv.slice(1), client, runtime);
    case "memory": return memoryCommand(argv.slice(1), client, runtime);
    case "watch": return watchCommand(argv.slice(1), client, runtime);
    case "status": return statusCommand(argv.slice(1), client, runtime);
    default: throw new ArgsError(`Unknown command: ${verb}`);
  }
}

export async function ghostCli(argv: readonly string[], options: GhostCliOptions = {}): Promise<number> {
  const runtime = runtimeOptions(options);
  try {
    return await dispatch(argv, runtime);
  } catch (error) {
    if (error instanceof CliError || error instanceof ArgsError) {
      runtime.stderr.write(`ghost: ${error.message}\n`);
      return error instanceof CliError ? error.exitCode : 2;
    }
    runtime.stderr.write(`ghost: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function isDirectInvocation(moduleUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(entryPath).href;
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  ghostCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
