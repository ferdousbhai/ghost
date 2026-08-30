import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export const CODEX_BINARY_ENV = "GHOST_CODEX_BINARY";
export const PI_BINARY_ENV = "GHOST_PI_BINARY";

async function executableFile(path: string): Promise<string | null> {
  try {
    await access(path, constants.X_OK);
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Resolve one known executable without invoking a shell or accepting cwd-relative PATH entries. */
export async function resolveHarnessExecutable(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (configured.includes("/")) {
    if (!isAbsolute(configured)) throw new Error("Configured harness executable must be absolute.");
    const resolved = await executableFile(configured);
    if (resolved) return resolved;
    throw new Error(`Harness executable ${JSON.stringify(configured)} is unavailable.`);
  }

  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const resolved = await executableFile(join(directory, configured));
    if (resolved) return resolved;
  }
  throw new Error(`Harness executable ${JSON.stringify(configured)} was not found in PATH.`);
}
