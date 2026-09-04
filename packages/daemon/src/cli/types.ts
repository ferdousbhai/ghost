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

/** One interactive answer read from the terminal during `ghost model login`. */
export type CliPrompt = (request: { query: string; secret: boolean }) => Promise<string>;

export interface GhostCliOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  stdout?: CliWritable;
  stderr?: CliWritable;
  fetch?: CliFetch;
  stdin?: CliStdin;
  /** Test/embedding seam for the local read-only delegation catalogue. */
  nativeHarnesses?: Pick<NativeHarnessCatalog, "list">;
  /** Test/embedding seam for terminal prompts; defaults to a readline over the real TTY. */
  prompt?: CliPrompt;
}

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: CliWritable;
  stderr: CliWritable;
  fetch: CliFetch;
  stdin: CliStdin;
  nativeHarnesses?: Pick<NativeHarnessCatalog, "list">;
  prompt?: CliPrompt;
}

export interface CliContext {
  parsed: ParsedCliArgs;
  runtime: CliRuntime;
  version: string;
  readonly client: DaemonClient;
}
