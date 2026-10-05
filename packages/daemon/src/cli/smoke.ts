import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort, waitUntilServing } from "../loopback.js";
import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { EXIT_CODE } from "./client.js";
import { ghostCli } from "./main.js";
import { emit } from "./output.js";
import type { CliContext, CliWritable, GhostCliOptions } from "./types.js";
import { errorMessage } from "@ghost/extensions";

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
    // Harnesses keep their sign-ins under the owner's own XDG config and data
    // directories, so only Ghost's config moves into the scratch tree.
    GHOSTD_CONFIG: join(scratch, "config", "ghost", "config.json"),
    GHOSTD_OFFLINE: "1",
  };
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
    const harness = flagString(parsed, "harness");
    if (harness) {
      step = "harness";
      writeFileSync(join(scratch, "ghosts", "probe", "settings.yml"), `harness: ${harness}\n`);
      report("harness", true, harness);
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

      // A second turn in the same conversation resumes the harness's own
      // session: the reply must show the conversation kept its context.
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
      if (listed.messageCount < 4) {
        throw new Error(`two turns recorded messageCount ${listed.messageCount}, expected 4`);
      }
      report("accounting", true, `messageCount ${listed.messageCount}`, true);
    }
  } catch (error) {
    code = EXIT_CODE.failure;
    const detail = errorMessage(error) || daemonError.trim() || "daemon failed";
    report(step, false, detail, true);
  } finally {
    await stopProcess(child);
    if (keep) report("scratch", true, scratch);
    else rmSync(scratch, { recursive: true, force: true });
  }
  return code;
}
