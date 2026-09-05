import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveClaudeCodeExecutable } from "../claude-code.js";
import { freePort, waitUntilServing } from "../loopback.js";
import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { EXIT_CODE } from "./client.js";
import { ghostCli } from "./main.js";
import { emit } from "./output.js";
import type { CliContext, CliWritable, GhostCliOptions } from "./types.js";

class Sink implements CliWritable {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

function splitCommand(value: string): string[] {
  const parts = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => {
    const quoted = (part.startsWith('"') && part.endsWith('"'))
      || (part.startsWith("'") && part.endsWith("'"));
    return quoted ? part.slice(1, -1) : part;
  });
}

function daemonCommand(ctx: CliContext): string[] {
  const configured = ctx.runtime.env.GHOSTD?.trim();
  if (configured) {
    const command = splitCommand(configured);
    if (command.length === 0) throw new ArgsError("GHOSTD is empty.");
    return command;
  }
  const candidates = [
    join(dirname(process.execPath), "ghostd"),
    process.argv[1] ? join(dirname(process.argv[1]), "ghostd") : "",
  ].filter(Boolean);
  return [candidates.find(existsSync) ?? "ghostd"];
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 5_000);
  });
  const result = await Promise.race([exited.then(() => "exit" as const), timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

async function runScratchCli(
  argv: string[],
  options: Omit<GhostCliOptions, "stdout" | "stderr">,
): Promise<{ stdout: string; stderr: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await ghostCli(argv, { ...options, stdout, stderr });
  if (code !== EXIT_CODE.success) {
    throw new Error(stderr.value.trim() || `ghost ${argv[0]} exited ${code}`);
  }
  return { stdout: stdout.value, stderr: stderr.value };
}

interface SmokeSession {
  readonly id: string;
  readonly messageCount: number;
}

function sessionRows(stdout: string): SmokeSession[] {
  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(rows)) throw new Error("ghost sessions --json returned no list");
  return rows.map((row) => {
    const record = row as { id?: unknown; messageCount?: unknown };
    if (typeof record.id !== "string" || typeof record.messageCount !== "number") {
      throw new Error("ghost sessions --json returned an unrecognised row");
    }
    return { id: record.id, messageCount: record.messageCount };
  });
}

function readSessionId(stdout: string): string {
  const rows = sessionRows(stdout);
  const first = rows[0];
  if (!first) throw new Error("the first turn created no conversation");
  return first.id;
}

function readSession(stdout: string, id: string): SmokeSession {
  const found = sessionRows(stdout).find((row) => row.id === id);
  if (!found) throw new Error(`conversation ${id} vanished from the listing`);
  return found;
}

export function smokeMemorySlugs(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ghost memory --json returned an unrecognised body");
  }
  const body = parsed as { memory?: unknown; skipped?: unknown };
  if (!Array.isArray(body.memory) || !Array.isArray(body.skipped)) {
    throw new Error("ghost memory --json returned an unrecognised body");
  }
  const slugs = body.memory.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("ghost memory --json returned an unrecognised memory row");
    }
    const slug = (row as { slug?: unknown }).slug;
    if (typeof slug !== "string" || !slug) {
      throw new Error("ghost memory --json returned a memory row without a slug");
    }
    return slug;
  });
  const skipped = body.skipped.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("ghost memory --json returned an unrecognised skipped row");
    }
    const { path, reason } = row as { path?: unknown; reason?: unknown };
    if (typeof path !== "string" || typeof reason !== "string") {
      throw new Error("ghost memory --json returned an unrecognised skipped row");
    }
    return { path, reason };
  });
  if (skipped.length > 0) {
    throw new Error(
      `unreadable memory file: ${skipped.map((row) => `${row.path} (${row.reason})`).join("; ")}`,
    );
  }
  if (slugs.length === 0) throw new Error("memory turn wrote no readable memory");
  return slugs;
}

export function smokeClaudeBinarySelection(
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  return environment.GHOST_CLAUDE_BINARY?.trim() || undefined;
}

export async function smokeCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const keep = flagBoolean(parsed, "keep");
  const scratch = mkdtempSync(join(tmpdir(), "ghost-smoke-"));
  const port = await freePort();
  const tokenFile = join(scratch, "state", "ghost", "api-token");
  const env: NodeJS.ProcessEnv = {
    ...ctx.runtime.env,
    GHOSTS_ROOT: join(scratch, "ghosts"),
    GHOSTD_PORT: String(port),
    GHOSTD_HOST: "127.0.0.1",
    GHOSTD_API_TOKEN_FILE: tokenFile,
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_DATA_HOME: join(scratch, "data"),
    GHOSTD_OFFLINE: "1",
  };
  // The scratch XDG dirs keep the daemon's own state out of the real ones, but
  // they also hide a mise-managed `claude` from it, because mise installs live
  // under the caller's real XDG_DATA_HOME. Resolve the launcher out here, where
  // the caller's environment is still intact, and hand the child the executable
  // through the documented override. A machine without Claude Code installed
  // simply does not get the variable, and pi runtimes are unaffected.
  try {
    const configuredBinary = smokeClaudeBinarySelection(ctx.runtime.env);
    env.GHOST_CLAUDE_BINARY = await resolveClaudeCodeExecutable(configuredBinary);
  } catch {
    // Not installed, or not resolvable: leave it to the daemon to report.
  }
  const command = daemonCommand(ctx);
  const child = spawn(command[0] as string, [...command.slice(1), "--port", String(port)], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let daemonError = "";
  child.on("error", (error) => {
    daemonError = error.message;
  });
  child.stderr?.on("data", (chunk) => {
    daemonError = `${daemonError}${String(chunk)}`.slice(-2_000);
  });
  const report = (step: string, ok: boolean, detail?: string, final = false) => {
    const result = { step, ok, ...(detail ? { detail } : {}) };
    emit(ctx, result, () => ({
      human: `${ok ? "ok" : "fail"} ${step}${detail ? `: ${detail}` : ""}\n`,
      ...(final ? { quiet: `${ok ? "ok" : "fail"} smoke\n` } : {}),
    }));
  };
  let code: number = EXIT_CODE.success;
  let step = "daemon";
  try {
    await waitUntilServing(port, child, 10_000);
    const options = {
      env,
      home: scratch,
      fetch: ctx.runtime.fetch,
      stdin: ctx.runtime.stdin,
    };
    const status = await runScratchCli(["status", "-q"], options);
    report("daemon", true, status.stdout.trim());
    step = "new probe";
    await runScratchCli(["new", "probe", "-q"], options);
    report("new probe", true);
    const model = flagString(parsed, "model");
    if (model) {
      step = "model";
      await runScratchCli(["model", model, "-g", "probe", "-q"], options);
      report("model", true, model);
    }
    step = "turn";
    if (flagBoolean(parsed, "no-turn")) {
      report("turn", true, "skipped (--no-turn)", true);
    } else {
      const turn = await runScratchCli([
        "say",
        "-q",
        "--new",
        "-g",
        "probe",
        "Reply with the single word: pong",
      ], options);
      const reply = turn.stdout.trim();
      if (!reply) throw new Error("turn returned no text");
      report("turn", true, reply);

      // A second turn in the same conversation. For a runtime that keeps its
      // process warm this rides the live one; either way the reply must show
      // the conversation kept its context, and the counts must add up.
      step = "second turn";
      const sessionId = readSessionId(
        (await runScratchCli(["sessions", "-g", "probe", "--json"], options)).stdout,
      );
      const followUp = await runScratchCli([
        "say",
        "-q",
        "-g",
        "probe",
        "-s",
        sessionId,
        "Repeat the word you just said, and nothing else.",
      ], options);
      const second = followUp.stdout.trim();
      if (!second) throw new Error("second turn returned no text");
      if (!/pong/i.test(second)) {
        throw new Error(`second turn lost the conversation's context: ${second}`);
      }
      report("second turn", true, second);

      step = "accounting";
      const listed = readSession(
        (await runScratchCli(["sessions", "-g", "probe", "--json"], options)).stdout,
        sessionId,
      );
      if (listed.messageCount < 6) {
        throw new Error(`three turns recorded messageCount ${listed.messageCount}, expected at least 6`);
      }
      report("accounting", true, `messageCount ${listed.messageCount}`, true);
    }
  } catch (error) {
    code = EXIT_CODE.failure;
    const detail = (error as Error).message || daemonError.trim() || "daemon failed";
    report(step, false, detail, true);
  } finally {
    await stopProcess(child);
    if (keep) report("scratch", true, scratch);
    else rmSync(scratch, { recursive: true, force: true });
  }
  return code;
}
