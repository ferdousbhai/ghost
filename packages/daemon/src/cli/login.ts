import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthType, LoginPromptView, LoginView, ProviderInfo } from "../auth.js";
import { ArgsError, flagBoolean, flagString, type ArgsSpec, type ParsedCliArgs } from "./args.js";
import { CliError, EXIT_CODE } from "./client.js";
import { resolveGhost, stdinIsTty, stdinText } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext, CliRuntime } from "./types.js";

/**
 * The daemon models a login as a pollable session with no event stream, so the
 * HUD polls it once a second; a terminal login is the same flow at the same
 * cadence.
 */
const POLL_INTERVAL_MS = 1_000;
/**
 * Flags only the sign-in verbs accept. `main.ts` merges them into the argv spec
 * for `login` and `logout` alone, so they stay unknown options on every other
 * verb.
 */
export const LOGIN_ARGS: ArgsSpec = {
  boolean: ["oauth", "api-key", "key-stdin"],
  value: [],
};

function providersPath(ghost: string): string {
  return `/api/ghosts/${encodeURIComponent(ghost)}/providers`;
}

async function listProviders(ctx: CliContext, ghost: string): Promise<ProviderInfo[]> {
  const response = await ctx.client.request<{ providers: ProviderInfo[] }>("GET", providersPath(ghost));
  return response.body.providers ?? [];
}

function providerIds(providers: readonly ProviderInfo[]): string {
  return providers.length > 0
    ? providers.map((provider) => provider.id).join(", ")
    : "no login-capable providers";
}

function interrupted(): CliError {
  return new CliError(
    EXIT_CODE.interrupted,
    "interrupted; the daemon has no cancel route, so this login times out on its own",
  );
}

/** Reads one answer from the real terminal, never echoing a secret. */
async function readFromTerminal(query: string, secret: boolean): Promise<string> {
  // readline echoes what is typed to its `output`; a secret answer therefore
  // gets a sink for an output and the query written straight to stdout.
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  if (secret) process.stdout.write(query);
  const rl = createInterface({
    input: process.stdin,
    output: secret ? sink : process.stdout,
    terminal: true,
  });
  const interrupt = new AbortController();
  rl.on("SIGINT", () => interrupt.abort());
  try {
    return await rl.question(secret ? "" : query, { signal: interrupt.signal });
  } catch (error) {
    if (interrupt.signal.aborted) throw interrupted();
    throw error;
  } finally {
    rl.close();
    if (secret) process.stdout.write("\n");
  }
}

async function readAnswer(runtime: CliRuntime, query: string, secret: boolean): Promise<string> {
  if (runtime.prompt) return await runtime.prompt({ query, secret });
  if (!stdinIsTty(runtime.stdin)) {
    throw new CliError(
      EXIT_CODE.usage,
      "this login needs an answer but stdin is not a terminal; pipe the key with --key-stdin",
    );
  }
  return await readFromTerminal(query, secret);
}

function chooseAuthType(provider: ProviderInfo, parsed: ParsedCliArgs): AuthType {
  const oauth = flagBoolean(parsed, "oauth");
  const apiKey = flagBoolean(parsed, "api-key");
  if (oauth && apiKey) throw new ArgsError("Choose --oauth or --api-key, not both.");
  // An api key is the flow a headless setup can complete unattended, so it wins
  // where a provider offers both and the owner did not ask for the browser.
  const chosen: AuthType = !oauth && (apiKey || provider.authTypes.includes("api_key"))
    ? "api_key"
    : "oauth";
  if (!provider.authTypes.includes(chosen)) {
    throw new ArgsError(
      `Provider ${JSON.stringify(provider.id)} does not offer ${chosen} login; `
      + `it offers ${provider.authTypes.join(", ")}.`,
    );
  }
  return chosen;
}

/**
 * Prints each state of a login the first time it appears, so a poll loop that
 * sees the same view repeatedly does not repeat itself.
 */
function renderState(view: LoginView, seen: Set<string>, write: (text: string) => void): void {
  const once = (key: string, text: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    write(text);
  };
  if (view.authUrl) {
    once(
      `url:${view.authUrl}`,
      `Open this URL to sign in:\n  ${view.authUrl}\n`
      + (view.authInstructions ? `${view.authInstructions}\n` : ""),
    );
  }
  if (view.deviceCode) {
    once(
      `code:${view.deviceCode}`,
      `Go to ${view.verificationUrl ?? "the provider's device page"} and enter the code:\n`
      + `  ${view.deviceCode}\n`
      + (view.deviceExpiresInSeconds === undefined
        ? ""
        : `The code expires in ${view.deviceExpiresInSeconds}s.\n`),
    );
  }
  if (view.message) once(`message:${view.message}`, `${view.message}\n`);
}

/** Reads one pending prompt's answer from the terminal. */
async function answerPrompt(prompt: LoginPromptView, ctx: CliContext): Promise<string> {
  if (flagBoolean(ctx.parsed, "json")) {
    throw new CliError(
      EXIT_CODE.usage,
      `this login asks ${JSON.stringify(prompt.message)}; --json cannot answer it, `
      + "so rerun without --json or pipe the key with --key-stdin",
    );
  }
  if (prompt.kind !== "select") {
    const query = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
    return (await readAnswer(ctx.runtime, query, prompt.secret)).trim();
  }
  const options = prompt.options ?? [];
  if (options.length === 0) {
    throw new CliError(EXIT_CODE.failure, "the daemon offered a choice with no options");
  }
  ctx.runtime.stdout.write(`${prompt.message}\n${options.map((option, index) =>
    `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`).join("")}`);
  const answer = (await readAnswer(ctx.runtime, "> ", false)).trim();
  const position = Number(answer);
  if (Number.isInteger(position) && position >= 1 && position <= options.length) {
    return (options[position - 1] as { id: string }).id;
  }
  const named = options.find((option) => option.id === answer || option.label === answer);
  if (!named) throw new CliError(EXIT_CODE.usage, `${JSON.stringify(answer)} is not one of the offered options`);
  return named.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The `ghost login --list` table: what there is to sign in to, and how. */
function renderProviders(ctx: CliContext, providers: readonly ProviderInfo[]): number {
  emit(ctx, { providers }, () => providers.length === 0
    ? "No login-capable providers.\n"
    : `${table(providers.map((provider) => [
        provider.id,
        provider.name,
        provider.authTypes.join(","),
        provider.configured ? (provider.connectedVia ?? "configured") : "—",
        provider.subscription ? "subscription" : "",
      ]), ["PROVIDER", "NAME", "AUTH", "SIGNED IN", "PLAN"])}\n`);
  return EXIT_CODE.success;
}

export async function loginCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const requested = parsed.positionals[0];
  const listing = flagBoolean(parsed, "list");
  if (listing && requested) throw new ArgsError("ghost login --list takes no provider");
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const providers = await listProviders(ctx, name);
  if (listing) return renderProviders(ctx, providers);
  if (!requested) {
    throw new ArgsError(`ghost login needs a provider; ghostd offers ${providerIds(providers)}.`);
  }
  const provider = providers.find((candidate) => candidate.id === requested);
  if (!provider) {
    throw new ArgsError(
      `No provider ${JSON.stringify(requested)} to log into; ghostd offers ${providerIds(providers)}.`,
    );
  }
  const authType = chooseAuthType(provider, parsed);
  // Read the piped key before the daemon opens a login, so a script that pipes
  // nothing fails without leaving a login to time out.
  let pipedKey: string | undefined;
  if (flagBoolean(parsed, "key-stdin")) {
    pipedKey = (await stdinText(ctx.runtime.stdin)).trim();
    if (!pipedKey) throw new ArgsError("--key-stdin read an empty key from stdin");
  }

  const base = `/api/ghosts/${encodeURIComponent(name)}/login`;
  let view = (await ctx.client.request<LoginView>("POST", base, { providerId: provider.id, authType })).body;
  const path = `${base}/${encodeURIComponent(view.loginId)}`;
  const silent = flagBoolean(parsed, "json") || flagBoolean(parsed, "quiet");
  const write = (text: string): void => {
    if (!silent) ctx.runtime.stdout.write(text);
  };
  write(`Signing ${name} in to ${provider.name} (${authType}).\n`);

  const seen = new Set<string>();
  while (view.status !== "succeeded" && view.status !== "failed") {
    renderState(view, seen, write);
    if (view.prompt) {
      // A piped key answers the first secret prompt and is spent there.
      let value: string;
      if (view.prompt.secret && pipedKey !== undefined) {
        value = pipedKey;
        pipedKey = undefined;
      } else value = await answerPrompt(view.prompt, ctx);
      view = (await ctx.client.request<LoginView>("POST", `${path}/input`, { value })).body;
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
    view = (await ctx.client.request<LoginView>("GET", path)).body;
  }
  renderState(view, seen, write);

  emit(ctx, view, (final) => final.status === "failed" ? "" : [
    `Signed in to ${provider.name} (${final.providerId}).`,
    final.modelBound
      ? `Chat model set to ${final.modelBound.provider}/${final.modelBound.modelId}.`
      : "Pick a model with `ghost model <provider>/<id>`.",
    "",
  ].join("\n"));
  if (view.status === "failed") {
    ctx.runtime.stderr.write(`ghost: ${view.error ?? "the login failed"}\n`);
    return EXIT_CODE.failure;
  }
  return EXIT_CODE.success;
}

export async function logoutCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const provider = parsed.positionals[0];
  if (!provider) throw new ArgsError("ghost logout needs a provider; see `ghost login --list`.");
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const body = (await ctx.client.request(
    "DELETE",
    `${providersPath(name)}/${encodeURIComponent(provider)}`,
  )).body;
  emit(ctx, body, () =>
    `Signed out of ${provider}.\n`);
  return EXIT_CODE.success;
}
