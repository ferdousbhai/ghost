/**
 * The daemon's own version. A bundled runtime carries it as a build-time
 * define (`scripts/build-runtime.sh`); a source checkout reads package.json.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const DAEMON_VERSION: string = process.env.GHOSTD_VERSION ?? readPackageVersion();
