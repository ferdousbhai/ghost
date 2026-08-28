import { homedir } from "node:os";
import { defaultConfigPath, loadConfig, writeConfigFile } from "./config.js";
import { RemoteServe, type RemoteStatus } from "./remote-serve.js";

export interface RemoteCommandOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  createRemoteServe?: (port: number, options: ConstructorParameters<typeof RemoteServe>[1]) => RemoteServe;
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

  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  try {
    const config = loadConfig({ env, home });
    const remoteServe = options.createRemoteServe?.(config.port, config.remote)
      ?? new RemoteServe(config.port, config.remote);
    let status: RemoteStatus;
    if (action === "on") {
      status = await remoteServe.enable();
      await writeConfigFile(config.configPath ?? defaultConfigPath(env, home), {
        remote: { enabled: true },
      });
      if (status.url && !status.problem) stdout(`${status.url}\n`);
      else stdout(statusScreen(status));
    } else if (action === "off") {
      status = await remoteServe.disable();
      await writeConfigFile(config.configPath ?? defaultConfigPath(env, home), {
        remote: { enabled: false },
      });
      stdout(status.problem ? statusScreen(status) : "Remote access is off.\n");
    } else {
      status = await remoteServe.status();
      stdout(statusScreen(status));
    }
    return status.problem ? 1 : 0;
  } catch (error) {
    stderr(`ghostd remote: ${(error as Error).message}\n`);
    return 1;
  }
}
