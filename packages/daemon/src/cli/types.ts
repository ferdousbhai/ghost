import type { ParsedCliArgs } from "./args.js";
import type { DaemonClient } from "./client.js";
import type { NativeHarnessCatalog } from "../native-harness-catalog.js";

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
  stdout?: CliWritable;
  stderr?: CliWritable;
  fetch?: CliFetch;
  stdin?: CliStdin;
  /** Test/embedding seam for the local read-only delegation catalogue. */
  nativeHarnesses?: Pick<NativeHarnessCatalog, "list">;
}

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: CliWritable;
  stderr: CliWritable;
  fetch: CliFetch;
  stdin: CliStdin;
  nativeHarnesses?: Pick<NativeHarnessCatalog, "list">;
}

export interface CliContext {
  parsed: ParsedCliArgs;
  runtime: CliRuntime;
  version: string;
  readonly client: DaemonClient;
}
