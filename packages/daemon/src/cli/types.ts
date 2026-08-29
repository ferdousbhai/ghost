export interface CliWritable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export type CliStdin =
  | string
  | { isTTY?: boolean; read?: () => unknown; on?: (...args: unknown[]) => unknown }
  | AsyncIterable<unknown>
  | Iterable<unknown>;

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
}

export interface CliRuntime {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: CliWritable;
  stderr: CliWritable;
  fetch: CliFetch;
  stdin: CliStdin;
}
