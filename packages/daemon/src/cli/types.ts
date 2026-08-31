import type { ParsedCliArgs } from "./args.js";
import type { DaemonClient } from "./client.js";
import type { DelegationStatusView } from "../delegation-status.js";

export interface CliWritable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export type CliStdin = string | (AsyncIterable<unknown> & { isTTY?: boolean });

export type CliFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface GhostCliOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  stdout?: CliWritable;
  stderr?: CliWritable;
  fetch?: CliFetch;
  stdin?: CliStdin;
  loadDelegationStatus?: DelegationStatusLoader;
}

export type DelegationStatusLoader = (input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ownerHome: string;
}) => Promise<DelegationStatusView>;

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  stdout: CliWritable;
  stderr: CliWritable;
  fetch: CliFetch;
  stdin: CliStdin;
  loadDelegationStatus?: DelegationStatusLoader;
}

export interface CliContext {
  parsed: ParsedCliArgs;
  runtime: CliRuntime;
  version: string;
  readonly client: DaemonClient;
}
