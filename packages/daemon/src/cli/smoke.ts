import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArgsError, flagBoolean, parseArgs, requirePositionals } from "./args.js";
import { CliError, DaemonClient } from "./client.js";
import { writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

function splitCommand(value: string): string[] {
  const parts = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => {
    const quoted = (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"));
    return quoted ? part.slice(1, -1) : part;
  });
}

function daemonCommand(runtime: CliRuntime): string[] {
  const configured = runtime.env.GHOSTD?.trim();
  if (configured) {
    const command = splitCommand(configured);
    if (command.length === 0) throw new ArgsError("GHOSTD is empty.");
    return command;
  }
  const candidates = [
    join(dirname(process.execPath), "ghostd"),
    process.argv[1] ? join(dirname(process.argv[1]), "ghostd") : "",
  ].filter(Boolean);
  const sibling = candidates.find(existsSync);
  return [sibling ?? "ghostd"];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("could not allocate a loopback port");
  return port;
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

export async function smokeCommand(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const parsed = parseArgs(argv, { boolean: ["keep", "no-turn"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("smoke"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost smoke [--keep] [--no-turn] [--json] [-q]");
  const keep = flagBoolean(parsed, "keep");
  const quiet = flagBoolean(parsed, "quiet");
  const scratch = mkdtempSync(join(tmpdir(), "ghost-smoke-"));
  const port = await freePort();
  const tokenFile = join(scratch, "state", "ghost", "api-token");
  const env: NodeJS.ProcessEnv = {
    ...runtime.env,
    GHOSTS_ROOT: join(scratch, "ghosts"),
    GHOSTD_PORT: String(port),
    GHOSTD_HOST: "127.0.0.1",
    GHOSTD_API_TOKEN_FILE: tokenFile,
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_DATA_HOME: join(scratch, "data"),
    GHOSTD_OFFLINE: "1",
  };
  const command = daemonCommand(runtime);
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
  const report = (step: string, ok: boolean, detail?: string) => {
    const result = { step, ok, ...(detail ? { detail } : {}) };
    if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, result);
    else if (!quiet) runtime.stdout.write(`${ok ? "ok" : "fail"} ${step}${detail ? `: ${detail}` : ""}\n`);
  };
  let code = 0;
  let step = "daemon";
  try {
    const smokeRuntime: CliRuntime = { ...runtime, env, home: scratch };
    const client = new DaemonClient(smokeRuntime);
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await client.request("GET", "/api/ghosts");
        break;
      } catch (error) {
        if (Date.now() >= deadline || child.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    report("daemon", true, client.baseUrl);
    step = "new probe";
    await client.request("POST", "/api/ghosts", { name: "probe" });
    report("new probe", true);
    if (!flagBoolean(parsed, "no-turn")) {
      step = "turn";
      let reply = "";
      await client.stream("/api/ghosts/probe/messages", {
        context: { messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word pong." }] }] },
        options: { sessionId: `cli-${Date.now().toString(36)}-smoke` },
      }, (event) => {
        const row = event as { type?: unknown; delta?: unknown; errorMessage?: unknown };
        if (row.type === "text_delta" && typeof row.delta === "string") reply += row.delta;
        if (row.type === "error") throw new Error(typeof row.errorMessage === "string" ? row.errorMessage : "turn failed");
      });
      if (!reply.trim()) throw new Error("turn returned no text");
      report("turn", true, reply.trim());
    } else report("turn", true, "skipped (--no-turn)");
  } catch (error) {
    code = 1;
    const detail = error instanceof CliError ? error.message : (error as Error).message;
    report(step, false, detail || daemonError.trim() || "daemon failed");
  } finally {
    await stopProcess(child);
    if (keep) report("scratch", true, scratch);
    else rmSync(scratch, { recursive: true, force: true });
  }
  if (quiet && !flagBoolean(parsed, "json")) runtime.stdout.write(`${code === 0 ? "ok" : "fail"} smoke\n`);
  return code;
}
