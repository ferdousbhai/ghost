import type { ParsedCliArgs } from "./args.js";
import type { DaemonClient } from "./client.js";

export interface CliWritable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export type CliStdin = string | (AsyncIterable<unknown> & { isTTY?: boolean });

export type CliFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: CliWritable;
  stderr: CliWritable;
  fetch: CliFetch;
  stdin: CliStdin;
}

/** The runtime ghostCli is given; whatever is left out is the process's own. */
export type GhostCliOptions = Partial<CliRuntime>;

export interface CliContext {
  parsed: ParsedCliArgs;
  runtime: CliRuntime;
  version: string;
  readonly client: DaemonClient;
}
