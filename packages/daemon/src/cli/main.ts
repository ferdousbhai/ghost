#!/usr/bin/env bun
import { DAEMON_VERSION } from "../version.js";
import { homedir } from "node:os";
import { isDirectInvocation } from "../direct-invocation.js";
import {
  ArgsError,
  flagBoolean,
  parseArgs,
  type ArgsSpec,
} from "./args.js";
import {
  characterCommand,
  readCommand,
  remoteCommand,
  harnessCommand,
  switchCommand,
} from "./admin.js";
import { CliError, DaemonClient, EXIT_CODE, EXIT_CODES } from "./client.js";
import { delegateCommand } from "./delegate.js";
import { harnessesCommand } from "./harnesses.js";
import { HELP_TOPICS, isHelpTopic, renderHelpTopic } from "../help-topics.js";
import { hooksCommand } from "./hooks.js";
import { sayCommand } from "./say.js";
import { askCommand, removeCommand, sessionActionCommand, sessionsCommand, showCommand, stopCommand } from "./sessions.js";
import { smokeCommand } from "./smoke.js";
import { statusCommand } from "./status.js";
import type { CliContext, CliRuntime, GhostCliOptions } from "./types.js";
import {
  renderCommandHelp,
  renderExitCodes,
  renderUsage,
  type CommandDocumentation,
} from "./usage.js";
import { errorMessage } from "../errors.js";

interface Command extends CommandDocumentation {
  positionals: readonly [minimum: number, maximum: number];
  /** Flags this verb alone accepts, on top of `CLI_ARGS` and the `-s` its usage lists. */
  flags?: ArgsSpec;
  run(ctx: CliContext): number | Promise<number>;
}

const CLI_ARGS: ArgsSpec = {
  boolean: ["version"],
};

export const COMMANDS: readonly Command[] = [
  {
    verb: "say",
    usage: "say [text] [-m <text>] [--new|--follow-up] [-s <id>] [--json] [-q]",
    summary: "Send a turn, or follow up on one.",
    example: 'ghost say --new "Start fresh"',
    positionals: [0, Number.POSITIVE_INFINITY],
    flags: { boolean: ["new", "follow-up"], value: ["message"] },
    run: sayCommand,
  },
  {
    verb: "stop",
    usage: "stop [-s <id>] [--json] [-q]",
    summary: "Stop a conversation's running turn.",
    example: "ghost stop -s cli-abc",
    positionals: [0, 0],
    run: stopCommand,
  },
  {
    verb: "rm",
    usage: "rm -s <id> --yes [--json] [-q]",
    summary: "Move a conversation to recoverable Trash.",
    example: "ghost rm -s cli-abc --yes",
    positionals: [0, 0],
    flags: { boolean: ["yes"] },
    run: removeCommand,
  },
  {
    verb: "sessions",
    usage: "sessions [--json] [-q]",
    summary: "List conversations.",
    example: "ghost sessions --json",
    positionals: [0, 0],
    run: sessionsCommand,
  },
  {
    verb: "show",
    flags: { value: ["limit", "offset"] },
    usage: "show [-s <id>] [--limit <n>] [--offset <n>] [--json] [-q]",
    summary: "Print a conversation transcript as Markdown: its newest page, or the page from --offset (counted from the oldest).",
    example: "ghost show -s cli-abc",
    positionals: [0, 0],
    run: showCommand,
  },
  {
    verb: "title",
    usage: "title <text> [-s <id>] [--json] [-q]",
    summary: "Rename a conversation.",
    example: 'ghost title "Release notes" -s cli-abc',
    positionals: [1, 1],
    run: (ctx) => sessionActionCommand("title", ctx),
  },
  {
    verb: "ask",
    flags: { boolean: ["clear"] },
    usage: "ask <question> [<answer>...] [--clear] [-s <id>] [--json] [-q]",
    summary: "Ask the owner; their next message in the conversation answers.",
    example: 'ghost ask "Ship it tonight?" yes "wait for review"',
    positionals: [0, 7],
    run: askCommand,
  },
  {
    verb: "pin",
    usage: "pin [-s <id>] [--json] [-q]",
    summary: "Pin a conversation.",
    example: "ghost pin -s cli-abc",
    positionals: [0, 0],
    run: (ctx) => sessionActionCommand("pin", ctx),
  },
  {
    verb: "unpin",
    usage: "unpin [-s <id>] [--json] [-q]",
    summary: "Unpin a conversation.",
    example: "ghost unpin -s cli-abc",
    positionals: [0, 0],
    run: (ctx) => sessionActionCommand("unpin", ctx),
  },
  {
    verb: "hooks",
    usage: "hooks [status|show|set <hooks.json>] [--json] [-q]",
    summary: "Show or replace the owner's hooks.json.",
    example: "ghost hooks show",
    positionals: [0, 2],
    run: hooksCommand,
  },
  {
    verb: "character",
    usage: "character [show|set <file>] [--json] [-q]",
    summary: "Print or replace the persona file.",
    example: "ghost character set ./casper.md",
    positionals: [0, 2],
    run: characterCommand,
  },
  {
    verb: "read",
    usage: "read [-s <id>] [--json] [-q]",
    summary: "Mark a conversation read.",
    example: "ghost read -s cli-abc",
    positionals: [0, 0],
    run: readCommand,
  },
  {
    verb: "remote",
    usage: "remote [status|on|off] [--json] [-q]",
    summary: "Show or toggle Tailscale Serve for the summonghost.com app.",
    example: "ghost remote on",
    positionals: [0, 1],
    run: remoteCommand,
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
    verb: "harnesses",
    usage: "harnesses [--json] [-q]",
    summary: "List installed agent CLIs and informational usage windows.",
    example: "ghost harnesses --json",
    positionals: [0, 0],
    run: harnessesCommand,
  },
  {
    verb: "harness",
    usage: "harness [<agent>|--none] [--json] [-q]",
    summary: "Show or set the agent a ghost prefers (--none: automatic).",
    example: "ghost harness claude",
    positionals: [0, 1],
    flags: { boolean: ["none"] },
    run: harnessCommand,
  },
  {
    verb: "switch",
    usage: "switch <agent> [-s <id>] [--json] [-q]",
    summary: "Run a conversation's next turn on another agent, handing it the conversation so far.",
    example: "ghost switch codex",
    positionals: [1, 1],
    run: switchCommand,
  },
  {
    verb: "delegate",
    usage: "delegate [--owner-named] <harness> -- <args...>",
    summary: "Run an installed harness here and record the handoff.",
    example: "cd ~/code/app && ghost delegate claude -- -p \"Fix the failing test\"",
    flags: { boolean: ["owner-named"] },
    positionals: [1, Number.POSITIVE_INFINITY],
    run: delegateCommand,
  },
  {
    verb: "smoke",
    usage: "smoke [--harness <id>] [--keep] [--no-turn] [--json] [-q]",
    summary: "Exercise a throwaway daemon and ghost home.",
    example: "ghost smoke --no-turn --json",
    positionals: [0, 0],
    flags: { boolean: ["keep", "no-turn"], value: ["harness"] },
    run: smokeCommand,
  },
  {
    verb: "help",
    usage: `help [command|exit-codes|${HELP_TOPICS.join("|")}]`,
    summary: "Show command help, the exit-code table, or one recipe the ghost's prompt points at.",
    example: "ghost help memory",
    positionals: [0, 1],
    run: (ctx) => {
      const topic = ctx.parsed.positionals[0];
      if (topic !== undefined && isHelpTopic(topic)) {
        // No daemon needed.
        ctx.runtime.stdout.write(renderHelpTopic(topic));
        return EXIT_CODE.success;
      }
      if (topic === undefined) ctx.runtime.stdout.write(USAGE);
      else if (topic === "exit-codes") ctx.runtime.stdout.write(EXIT_CODES_TEXT);
      else {
        const command = COMMANDS.find((candidate) => candidate.verb === topic);
        if (!command) throw new ArgsError(`Unknown help topic: ${topic}`);
        ctx.runtime.stdout.write(renderCommandHelp(command));
      }
      return EXIT_CODE.success;
    },
  },
];

/**
 * The common flags plus one verb's own; `-s` only where its usage lists it,
 * so a stray one is the unknown option it is, not silently ignored.
 */
function commandArgs(command: Command): ArgsSpec {
  return {
    boolean: [...CLI_ARGS.boolean ?? [], ...command.flags?.boolean ?? []],
    value: [...command.usage.includes("-s <id>") ? ["session"] : [], ...command.flags?.value ?? []],
  };
}

/** Every verb's flags at once: enough to find the verb, not to validate it. */
const EVERY_ARG: ArgsSpec = {
  boolean: [...new Set(COMMANDS.flatMap((command) => commandArgs(command).boolean ?? []))],
  value: [...new Set(COMMANDS.flatMap((command) => commandArgs(command).value ?? []))],
};

const USAGE = renderUsage(COMMANDS);
const EXIT_CODES_TEXT = renderExitCodes(EXIT_CODES);

function version(runtime: Pick<CliRuntime, "env">): string {
  // The injected env is consulted first so the test seam still overrides the
  // build-time define and the checkout's package.json behind DAEMON_VERSION.
  return runtime.env.GHOSTD_VERSION?.trim() || DAEMON_VERSION;
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
  // Two passes: the first knows every verb's flags and is trusted only for the
  // verb, the second holds that verb to its own, so `--keep` on any verb but
  // smoke is the unknown option it is.
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
  const all = parseArgs(argv, commandArgs(command));
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
  return await command.run(ctx);
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
    runtime.stderr.write(`ghost: ${errorMessage(error)}\n`);
    return EXIT_CODE.failure;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  ghostCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
