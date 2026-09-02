import type { Context, Model } from "@earendil-works/pi-ai";
import { isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { scrubProviderEnv } from "./env-scrub.js";
import { ghostPaths, isGhostHome } from "./ghosts.js";
import {
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveModelRoleRef,
  resolveSmolModelRef,
} from "./models.js";
import { createGhostPiRuntime } from "./pi-runtime.js";
import {
  assistantText,
  resolveSmolModel,
  type HookModelRole,
  smolCatalogFromRuntime,
  smolModelLabel,
  SmolModelUnavailableError,
  type SmolRuntime,
} from "./smol.js";

export const HOOK_SMOL_MAX_STDIN_BYTES = 1024 * 1024;
export const HOOK_SMOL_TIMEOUT_MS = 180_000;

export interface HookSmolInput {
  ghost_home: string;
  prompt: string;
  role?: HookModelRole;
}

export interface HookSmolRuntime extends SmolRuntime {
  close(): void;
}

export interface HookSmolOptions {
  runtimeFactory?: (input: {
    authPath: string;
    modelsPath: string;
    allowModelNetwork: boolean;
  }) => Promise<HookSmolRuntime>;
  signal?: AbortSignal;
}

function hookContext(prompt: string): Context {
  return {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  };
}

export async function completeHookSmol(
  input: HookSmolInput,
  options: HookSmolOptions = {},
): Promise<string> {
  if (!isAbsolute(input.ghost_home)) throw new Error("ghost_home must be an absolute path.");
  if (!input.prompt.trim()) throw new Error("prompt must be a non-empty string.");

  const home = await realpath(resolve(input.ghost_home));
  if (!isGhostHome(home)) throw new Error(`${home} is not a Ghost home.`);
  const paths = ghostPaths(home);
  const runtimeFactory = options.runtimeFactory ?? createGhostPiRuntime;
  const runtime = await runtimeFactory({
    authPath: ghostAuthPath(paths.agentDir),
    modelsPath: ghostModelsPath(paths.home),
    allowModelNetwork: false,
  });

  try {
    const models = readGhostModels(paths.home);
    const role = input.role ?? "smol_model";
    const ref = role === "smol_model"
      ? resolveSmolModelRef(models)
      : resolveModelRoleRef(models, role);
    const resolved = resolveSmolModel(smolCatalogFromRuntime(runtime), ref, role);
    const model = runtime.getModel(resolved.model.provider, resolved.model.id);
    if (!model) {
      throw new SmolModelUnavailableError(
        `The resolved smol model ${smolModelLabel(resolved.model)} vanished from the catalogue.`,
        "unknown_model",
      );
    }
    const response = await runtime.complete(
      model as Model<never>,
      hookContext(input.prompt),
      options.signal ? { signal: options.signal } : {},
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new SmolModelUnavailableError(
        `${smolModelLabel(resolved.model)} failed to complete the hook review: `
        + (response.errorMessage ?? response.stopReason),
        "provider_error",
      );
    }
    const text = assistantText(response);
    if (!text) {
      throw new SmolModelUnavailableError(
        `${smolModelLabel(resolved.model)} returned no hook review text.`,
        "empty_response",
      );
    }
    return text;
  } finally {
    runtime.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > HOOK_SMOL_MAX_STDIN_BYTES) {
      throw new Error(`stdin exceeds ${HOOK_SMOL_MAX_STDIN_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw: string): HookSmolInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`stdin is not valid JSON: ${(error as Error).message}`);
  }
  const input = value as Partial<HookSmolInput> | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("stdin must contain a JSON object.");
  }
  if (typeof input.ghost_home !== "string" || typeof input.prompt !== "string") {
    throw new Error("stdin must contain string ghost_home and prompt fields.");
  }
  if (input.role !== undefined && input.role !== "smol_model" && input.role !== "advisor_model") {
    throw new Error("stdin role must be smol_model or advisor_model.");
  }
  return {
    ghost_home: input.ghost_home,
    prompt: input.prompt,
    ...(input.role ? { role: input.role } : {}),
  };
}

export async function hookSmolCompleteCommand(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("hook-smol-complete accepts JSON on stdin and no arguments.\n");
    return 2;
  }
  try {
    // This subcommand bypasses daemon boot, so it owns the same credential
    // isolation before constructing a pi runtime.
    scrubProviderEnv(process.env, { offline: false });
    const input = parseInput(await readStdin());
    const signal = AbortSignal.timeout(HOOK_SMOL_TIMEOUT_MS);
    const text = await completeHookSmol(input, { signal });
    process.stdout.write(`${JSON.stringify({ text })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
