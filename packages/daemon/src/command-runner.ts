/** Runs one short-lived binary (systemctl, tailscale, …) and collects its output. */
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs one binary; a non-zero exit is a result, a missing binary (ENOENT) rejects. */
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export function commandRunner(binary: string): CommandRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await exec(binary, [...args], { encoding: "utf8", timeout: 10_000 });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failed = error as ExecFileException & { stdout?: string; stderr?: string };
      if (failed.code === "ENOENT") throw error;
      return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: typeof failed.code === "number" ? failed.code : 1 };
    }
  };
}
