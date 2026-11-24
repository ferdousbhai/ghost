/**
 * Which of the owner's coding agents a turn's prompt names: Omarchy's default
 * agent when it is one Ghost has a command for and is installed, else the
 * first of those installed. Ghost runs none of them itself; the local model
 * runs the one named from its shell (CONTRACTS.md "Local model").
 */
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The one-shot command of each coding agent the prompt can name: run with a
 * task, it works without asking and prints its steps, then its answer. A
 * model is likely to know these already; Ghost teaches it no command of its
 * own. Claude prints only its answer unless it streams JSON, which `jq` turns
 * back into lines: each text it writes, and each tool it uses with its input.
 */
export const CODING_AGENT_COMMANDS: Readonly<Record<string, string>> = {
  claude: String.raw`claude -p "<task>" --verbose --output-format stream-json | jq --unbuffered -r '.message.content[]?|.text//(select(.name)|"\(.name) \(.input)")'`,
  codex: 'codex exec "<task>"',
  agy: 'agy -p "<task>"',
};

/** The executable `name` resolves to on `env.PATH`, or null. */
export function which(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

async function succeeds(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec(file, args, { env, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Omarchy's own test (`agent_present` in `omarchy-default-agent`): an agent with
 * an `omarchy-install-<id>-cli` installer is installed when its `--check` says
 * so; a first-run mise stub (a regular file with a `mise use -g "<package>"`
 * line) only once `mise where <package>` finds some installed version, so a
 * pending update is not a cold install; anything else on PATH is the owner's own.
 */
async function isInstalled(id: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = which(id, env);
  if (path === null) return false;
  const installer = which(`omarchy-install-${id}-cli`, env);
  if (installer !== null) return succeeds(installer, ["--check"], env);
  let stubPackage: string | null = null;
  try {
    // A stub is a short script; a large file is a real binary and is never read.
    const stat = lstatSync(path);
    if (stat.isFile() && stat.size <= 64 * 1024) {
      stubPackage = /^mise use -g(?:\s+--?[\w-]+)*\s+"?([^"\s]+)"?/mu.exec(readFileSync(path, "utf8"))?.[1] ?? null;
    }
  } catch {
    // Unreadable: treat it as the owner's own install.
  }
  return stubPackage === null ? true : succeeds("mise", ["where", stubPackage], env);
}

/** Omarchy's default agent (`omarchy default agent`), or null when none is chosen. */
async function omarchyDefaultAgent(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await exec("omarchy-default-agent", [], { env, timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The coding agent to name, or null with none of them installed. */
export async function chooseCodingAgent(env: NodeJS.ProcessEnv): Promise<string | null> {
  const chosen = await omarchyDefaultAgent(env);
  const ids = Object.keys(CODING_AGENT_COMMANDS);
  for (const id of chosen !== null && ids.includes(chosen) ? [chosen, ...ids.filter((other) => other !== chosen)] : ids) {
    if (await isInstalled(id, env)) return id;
  }
  return null;
}
