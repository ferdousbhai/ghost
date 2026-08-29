import { ghostCli } from "../../src/cli/main.js";
import type { CliStdin, CliWritable, GhostCliOptions } from "../../src/cli/types.js";

export class Sink implements CliWritable {
  value = "";
  isTTY = false;

  write(chunk: string): void {
    this.value += chunk;
  }
}

export const TTY_STDIN: CliStdin = {
  isTTY: true,
  async *[Symbol.asyncIterator]() {},
};

export async function runCli(
  argv: readonly string[],
  overrides: Omit<GhostCliOptions, "stdout" | "stderr"> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await ghostCli(argv, {
    stdin: TTY_STDIN,
    ...overrides,
    stdout,
    stderr,
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}
