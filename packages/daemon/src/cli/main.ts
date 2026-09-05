#!/usr/bin/env bun
import { homedir } from "node:os";
import { isDirectInvocation } from "../direct-invocation.js";
import {
  ArgsError,
  flagBoolean,
  parseArgs,
  type ArgsSpec,
  type ParsedCliArgs,
} from "./args.js";
import { askCommand } from "./ask.js";
import { CliError, DaemonClient, EXIT_CODE, EXIT_CODES } from "./client.js";
import { FLYWHEEL_ARGS, flywheelCommand } from "./flywheel.js";
import { ghostsCommand } from "./ghosts.js";
import { LOGIN_ARGS, loginCommand, logoutCommand } from "./login.js";
import { memoryCommand } from "./memory.js";
import { modelCommand } from "./model.js";
import { sayCommand } from "./say.js";
import { sessionActionCommand, sessionsCommand, showCommand } from "./sessions.js";
import { renderSkillText, skillCommand } from "./skill.js";
import { smokeCommand } from "./smoke.js";
import { statusCommand } from "./status.js";
import type { CliContext, CliRuntime, GhostCliOptions } from "./types.js";
import {
  renderCommandHelp,
  renderExitCodes,
  renderUsage,
  type CommandDocumentation,
} from "./usage.js";
import { watchCommand } from "./watch.js";
import { jobsCommand } from "./work.js";

interface Command extends CommandDocumentation {
  positionals: readonly [minimum: number, maximum: number];
  /** Flags this verb alone accepts, on top of `CLI_ARGS`. */
  flags?: ArgsSpec;
  run(parsed: ParsedCliArgs, ctx: CliContext): number | Promise<number>;
}

const CLI_ARGS: ArgsSpec = {
  boolean: [
    "version",
    "new",
    "steer",
    "follow-up",
    "yes",
    "list",
    "exit-on-first",
    "keep",
    "no-turn",
  ],
  value: ["ghost", "session", "message", "limit", "offset", "q", "model"],
};

export const COMMANDS: readonly Command[] = [
  {
    verb: "say",
    usage: "say [text] [-m <text>] [--new|--steer|--follow-up] [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Send a turn, or steer/follow up on one.",
    example: 'ghost say --new "Start fresh"',
    positionals: [0, Number.POSITIVE_INFINITY],
    run: sayCommand,
  },
  {
    verb: "list",
    usage: "list [--json] [-q]",
    summary: "List ghosts and their home directories.",
    example: "ghost list --json",
    positionals: [0, 0],
    run: (parsed, ctx) => ghostsCommand("list", parsed, ctx),
  },
  {
    verb: "new",
    usage: "new <name> [--json] [-q]",
    summary: "Create a ghost through ghostd.",
    example: "ghost new sage",
    positionals: [1, 1],
    run: (parsed, ctx) => ghostsCommand("new", parsed, ctx),
  },
  {
    verb: "rm",
    usage: "rm <name> --yes | rm -s <id> --yes [-g <name>] [--json] [-q]",
    summary: "Move a ghost or conversation to recoverable Trash.",
    example: "ghost rm sage --yes",
    positionals: [0, 1],
    run: (parsed, ctx) => ghostsCommand("rm", parsed, ctx),
  },
  {
    verb: "use",
    usage: "use [<name>] [--json] [-q]",
    summary: "Print or persist the private default ghost.",
    example: "ghost use sage",
    positionals: [0, 1],
    run: (parsed, ctx) => ghostsCommand("use", parsed, ctx),
  },
  {
    verb: "sessions",
    usage: "sessions [-g <name>] [--json] [-q]",
    summary: "List conversations.",
    example: "ghost sessions -g sage",
    positionals: [0, 0],
    run: sessionsCommand,
  },
  {
    verb: "show",
    usage: "show [-g <name>] [-s <id>] [--limit <n>] [--offset <n>] [--json] [-q]",
    summary: "Print a conversation transcript as Markdown.",
    example: "ghost show -s cli-abc",
    positionals: [0, 0],
    run: showCommand,
  },
  {
    verb: "title",
    usage: "title <text> [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Rename a conversation.",
    example: 'ghost title "Release notes" -s cli-abc',
    positionals: [1, 1],
    run: (parsed, ctx) => sessionActionCommand("title", parsed, ctx),
  },
  {
    verb: "fork",
    usage: "fork <entryId> [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Fork a conversation before a user entry.",
    example: "ghost fork entry-123 -s cli-abc",
    positionals: [1, 1],
    run: (parsed, ctx) => sessionActionCommand("fork", parsed, ctx),
  },
  {
    verb: "pin",
    usage: "pin [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Pin a conversation.",
    example: "ghost pin -s cli-abc",
    positionals: [0, 0],
    run: (parsed, ctx) => sessionActionCommand("pin", parsed, ctx),
  },
  {
    verb: "unpin",
    usage: "unpin [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Unpin a conversation.",
    example: "ghost unpin -s cli-abc",
    positionals: [0, 0],
    run: (parsed, ctx) => sessionActionCommand("unpin", parsed, ctx),
  },
  {
    verb: "ask",
    usage: "ask [answer <label|index|text>|chat|skip] [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Inspect or resolve one pending question.",
    example: "ghost ask answer 1 -s cli-abc",
    positionals: [0, 2],
    run: askCommand,
  },
  {
    verb: "jobs",
    usage: "jobs [show <jobId>|cancel <jobId>] [-g <name>] [-s <id>] [--json] [-q]",
    summary: "Inspect or cancel background jobs.",
    example: "ghost jobs show job-1 -s cli-abc",
    positionals: [0, 2],
    run: jobsCommand,
  },
  {
    verb: "model",
    usage: "model [provider/id] [--list] [--q <text>] [-g <name>] [--json] [-q]",
    summary: "Show, set, or search chat models.",
    example: "ghost model --list --q claude",
    positionals: [0, 1],
    run: modelCommand,
  },
  {
    verb: "login",
    usage: "login <provider>|--list [--oauth|--api-key] [--key-stdin] [-g <name>] [--json] [-q]",
    summary: "Sign in to a provider, or list the providers.",
    example: "ghost login openrouter",
    flags: LOGIN_ARGS,
    positionals: [0, 1],
    run: loginCommand,
  },
  {
    verb: "logout",
    usage: "logout <provider> [-g <name>] [--json] [-q]",
    summary: "Sign out of a provider.",
    example: "ghost logout openrouter",
    flags: LOGIN_ARGS,
    positionals: [0, 1],
    run: logoutCommand,
  },
  {
    verb: "memory",
    usage: "memory [show <name>] [-g <name>] [--json] [-q]",
    summary: "List or read ghost memory files.",
    example: "ghost memory show owner-name",
    positionals: [0, 2],
    run: memoryCommand,
  },
  {
    verb: "watch",
    usage: "watch [-g <name>] [--exit-on-first] [--json] [-q]",
    summary: "Stream conversation invalidations as JSON lines.",
    example: "ghost watch --exit-on-first",
    positionals: [0, 0],
    run: watchCommand,
  },
  {
    verb: "flywheel",
    usage: "flywheel export --out <dir> [--since <iso>] [--holdout <fraction>]"
      + " [--system full|character] [--context-turns <n>] [--max-tool-result-chars <n>]"
      + " [-g <name>] [--json] [-q]",
    summary: "Export reviewed turns as training data, without the daemon.",
    example: "ghost flywheel export --out ./dataset",
    flags: FLYWHEEL_ARGS,
    positionals: [1, 1],
    run: flywheelCommand,
  },
  {
    verb: "status",
    usage: "status [--json] [-q]",
    summary: "Check daemon connectivity and authentication.",
    example: "ghost status --json",
    positionals: [0, 0],
    run: statusCommand,
  },
  {
    verb: "smoke",
    usage: "smoke [--model <provider/id>] [--keep] [--no-turn] [--json] [-q]",
    summary: "Exercise a throwaway daemon and ghost home.",
    example: "ghost smoke --no-turn --json",
    positionals: [0, 0],
    run: smokeCommand,
  },
  {
    verb: "skill",
    usage: "skill [--json] [-q]",
    summary: "Print the agent-oriented command reference.",
    example: "ghost skill",
    positionals: [0, 0],
    run: (parsed, ctx) => skillCommand(parsed, ctx, renderSkillText(COMMANDS, EXIT_CODES)),
  },
  {
    verb: "help",
    usage: "help [command|exit-codes]",
    summary: "Show command help or the stable exit-code table.",
    example: "ghost help exit-codes",
    positionals: [0, 1],
    run: (parsed, ctx) => {
      const topic = parsed.positionals[0];
      ctx.runtime.stdout.write(
        topic === "exit-codes" ? EXIT_CODES_TEXT : topic ? commandHelp(topic) : USAGE,
      );
      return EXIT_CODE.success;
    },
  },
];

/** The common flags plus one verb's own. */
function argsWith(extra: ArgsSpec | undefined): ArgsSpec {
  if (!extra) return CLI_ARGS;
  return {
    boolean: [...CLI_ARGS.boolean ?? [], ...extra.boolean ?? []],
    value: [...CLI_ARGS.value ?? [], ...extra.value ?? []],
  };
}

/** Every verb's flags at once: enough to find the verb, not to validate it. */
const EVERY_ARG = argsWith({
  boolean: COMMANDS.flatMap((command) => command.flags?.boolean ?? []),
  value: COMMANDS.flatMap((command) => command.flags?.value ?? []),
});

export const USAGE = renderUsage(COMMANDS);
export const EXIT_CODES_TEXT = renderExitCodes(EXIT_CODES);

export function commandHelp(verb: string): string {
  const command = COMMANDS.find((candidate) => candidate.verb === verb);
  return command ? renderCommandHelp(command) : USAGE;
}

export function version(runtime: Pick<CliRuntime, "env">): string {
  // The literal `process.env.GHOSTD_VERSION` read is load-bearing: the release
  // bundle bakes the version by textual substitution of exactly that
  // expression (scripts/build-runtime.sh --define). The injected env is
  // consulted first so the test seam still overrides it.
  return runtime.env.GHOSTD_VERSION?.trim()
    || process.env.GHOSTD_VERSION?.trim()
    || "0.0.0";
}

function runtimeOptions(options: GhostCliOptions): CliRuntime {
  return {
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    fetch: options.fetch ?? globalThis.fetch,
    stdin: options.stdin ?? process.stdin,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  };
}

async function dispatch(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  // Two passes: the first knows every verb's flags and is trusted only for the
  // verb, the second holds that verb to its own, so a sign-in flag on any other
  // verb is the unknown option it is.
  const scouted = parseArgs(argv, EVERY_ARG);
  if (flagBoolean(scouted, "version")) {
    runtime.stdout.write(`${version(runtime)}\n`);
    return EXIT_CODE.success;
  }

  const [verb] = scouted.positionals;
  if (!verb) {
    runtime.stdout.write(USAGE);
    return EXIT_CODE.success;
  }
  const command = COMMANDS.find((candidate) => candidate.verb === verb);
  if (!command) throw new ArgsError(`Unknown command: ${verb}`);
  const all = parseArgs(argv, argsWith(command.flags));
  const [, ...positionals] = all.positionals;
  const parsed = { ...all, positionals };
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(renderCommandHelp(command));
    return EXIT_CODE.success;
  }
  const [minimum, maximum] = command.positionals;
  if (positionals.length < minimum || positionals.length > maximum) {
    throw new ArgsError(`Usage: ghost ${command.usage}`);
  }

  let client: DaemonClient | undefined;
  const ctx: CliContext = {
    parsed,
    runtime,
    version: version(runtime),
    get client() {
      if (!client) client = new DaemonClient(runtime);
      return client;
    },
  };
  return await command.run(parsed, ctx);
}

export async function ghostCli(argv: readonly string[], options: GhostCliOptions = {}): Promise<number> {
  const runtime = runtimeOptions(options);
  try {
    return await dispatch(argv, runtime);
  } catch (error) {
    if (error instanceof CliError || error instanceof ArgsError) {
      runtime.stderr.write(`ghost: ${error.message}\n`);
      return error instanceof CliError ? error.exitCode : EXIT_CODE.usage;
    }
    runtime.stderr.write(`ghost: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODE.failure;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  ghostCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
