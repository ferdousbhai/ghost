import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { RemoteServe, type RemoteStatus } from "./remote-serve.js";
import type { CommandRunner } from "./tailscale-identity.js";

export interface RemoteCommandOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Test seam over `tailscale`. */
  run?: CommandRunner;
}

function statusScreen(status: RemoteStatus): string {
  const lines = [
    `State: ${status.state}`,
    `URL: ${status.url ?? "—"}`,
    `Owner: ${status.owner ?? "unknown"}`,
    `Guests: ${status.guests}`,
  ];
  if (status.problem) lines.push(`Problem: ${status.problem.message}`);
  if (status.problem?.action) lines.push(`Action: ${status.problem.action}`);
  return `${lines.join("\n")}\n`;
}

/** `ghostd remote [on|off|status]` controls Tailscale Serve without going through HTTP. */
export async function remoteCommand(
  argv: readonly string[] = [],
  options: RemoteCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const action = argv[0] ?? "status";
  if (argv.length > 1 || !["on", "off", "status"].includes(action)) {
    stderr("Usage: ghostd remote [on|off|status]\n");
    return 2;
  }
  try {
    const config = loadConfig({ env: options.env ?? process.env, home: options.home ?? homedir() });
    const remote = new RemoteServe(config.port, {
      ...config.remote,
      configPath: config.configPath,
      ...(options.run ? { run: options.run } : {}),
    });
    const status = action === "status" ? await remote.status() : await remote.setEnabled(action === "on");
    if (action === "on" && status.url && !status.problem) stdout(`${status.url}\n`);
    else if (action === "off" && !status.problem) stdout("Remote access is off.\n");
    else stdout(statusScreen(status));
    return status.problem ? 1 : 0;
  } catch (error) {
    stderr(`ghostd remote: ${(error as Error).message}\n`);
    return 1;
  }
}
