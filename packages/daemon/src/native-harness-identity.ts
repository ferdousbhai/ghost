import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { runOwnedCommand, type OwnedCommandResult } from "./owned-process.js";

export type NativeHarnessId = "claude-code" | "codex" | "pi";
const NATIVE_HARNESS_BINARY_NAMES = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
} as const satisfies Readonly<Record<NativeHarnessId, "claude" | "codex" | "pi">>;
type NativeHarnessBinaryName = (typeof NATIVE_HARNESS_BINARY_NAMES)[NativeHarnessId];

export interface NativeHarnessExecutable {
  readonly path: string;
  readonly identity: string;
  readonly literalBoundary: boolean;
}

export interface ResolveNativeHarnessExecutableOptions {
  harness: NativeHarnessId;
  explicitBinary?: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
}

export class NativeHarnessIdentityError extends Error {
  readonly _tag = "NativeHarnessIdentityError";
  readonly reason: "unavailable" | "mise" | "invalid";

  constructor(
    message: string,
    reason: "unavailable" | "mise" | "invalid" = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeHarnessIdentityError";
    this.reason = reason;
  }
}

interface BigintExecutableStat {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function executableStatIdentity(value: BigintExecutableStat): readonly string[] {
  return [
    value.dev.toString(),
    value.ino.toString(),
    value.mode.toString(),
    value.size.toString(),
    value.mtimeNs.toString(),
    value.ctimeNs.toString(),
  ];
}

async function executableCandidate(
  binaryPath: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string | null> {
  const candidates = isAbsolute(binaryPath) || binaryPath.includes("/")
    ? [resolve(binaryPath)]
    : (environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => resolve(directory, binaryPath));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Report one bounded harness error after every candidate is exhausted.
    }
  }
  return null;
}

async function launcherPrefix(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function unwrapMiseLauncher(
  path: string,
  binaryName: NativeHarnessBinaryName,
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
): Promise<string> {
  const prefix = await launcherPrefix(path);
  const word = new RegExp(`\\b${binaryName.replaceAll("-", "\\-")}\\b`, "u");
  if (!prefix.startsWith("#!") || !/\bmise\b/u.test(prefix) || !word.test(prefix)) {
    return path;
  }

  const miseCandidate = await executableCandidate("mise", environment);
  if (!miseCandidate) {
    throw new NativeHarnessIdentityError("Default mise launcher could not be resolved.", "mise");
  }
  let result: OwnedCommandResult;
  try {
    result = await runOwnedCommand(await realpath(miseCandidate), ["which", binaryName], {
      environment,
      timeoutMs,
    });
  } catch {
    throw new NativeHarnessIdentityError("Default mise launcher could not be resolved.", "mise");
  }
  if (result.exitCode !== 0 || result.signal) {
    throw new NativeHarnessIdentityError(
      "Default mise launcher did not resolve successfully.",
      "mise",
    );
  }
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const [selected] = lines;
  if (lines.length !== 1 || !selected) {
    throw new NativeHarnessIdentityError(
      "Default mise launcher returned an invalid executable.",
      "mise",
    );
  }
  const resolved = await executableCandidate(selected, environment);
  if (!resolved || resolved === path) {
    throw new NativeHarnessIdentityError("Default mise launcher did not resolve a target.", "mise");
  }
  return await realpath(resolved);
}

export async function inspectNativeHarnessExecutable(
  binaryPath: string,
  literalBoundary: boolean,
): Promise<string> {
  if (!isAbsolute(binaryPath)) {
    throw new NativeHarnessIdentityError("Native harness executable is not absolute.");
  }
  const boundary = await lstat(binaryPath, { bigint: true });
  if (!boundary.isFile() && !boundary.isSymbolicLink()) {
    throw new NativeHarnessIdentityError("Native harness boundary is not a file or link.");
  }
  const targetPath = await realpath(binaryPath);
  const target = await stat(targetPath, { bigint: true });
  if (!target.isFile()) {
    throw new NativeHarnessIdentityError("Native harness target is not a regular file.");
  }
  await access(binaryPath, fsConstants.X_OK);
  return createHash("sha256").update(JSON.stringify([
    literalBoundary,
    binaryPath,
    executableStatIdentity(boundary),
    targetPath,
    executableStatIdentity(target),
  ])).digest("hex");
}

export async function resolveNativeHarnessExecutable(
  options: ResolveNativeHarnessExecutableOptions,
): Promise<NativeHarnessExecutable> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("Native harness executable timeout must be a finite positive number.");
  }
  const literalBoundary = options.explicitBinary !== undefined;
  const candidate = await executableCandidate(
    options.explicitBinary ?? NATIVE_HARNESS_BINARY_NAMES[options.harness],
    options.environment,
  );
  if (!candidate) {
    throw new NativeHarnessIdentityError(
      "Native harness executable is unavailable.",
      "unavailable",
    );
  }
  const boundaryIdentity = await inspectNativeHarnessExecutable(candidate, literalBoundary);
  if (literalBoundary) {
    return Object.freeze({
      path: candidate,
      identity: boundaryIdentity,
      literalBoundary,
    });
  }
  const path = await realpath(await unwrapMiseLauncher(
    candidate,
    NATIVE_HARNESS_BINARY_NAMES[options.harness],
    options.environment,
    options.timeoutMs,
  ));
  return Object.freeze({
    path,
    identity: await inspectNativeHarnessExecutable(path, literalBoundary),
    literalBoundary,
  });
}
