/**
 * `ghostd login` — the same provider login the shell drives over HTTP, but on
 * a TTY, for headless setups and for anyone who would rather stay in the
 * terminal.
 *
 * It talks to OMP directly rather than through `LoginManager`: the manager
 * exists to make an interactive flow *pollable* over HTTP, which a terminal
 * does not need — here `readline` supplies the same `AuthInteraction` OMP's
 * `auth-command` builds from a TTY. The one thing shared with the HTTP path is
 * `bindDefaultChatModelIfUnset`, so both leave a signed-in ghost ready to chat.
 *
 * Credentials are written by `login()` to the ghost's `<home>/.pi/agent.db`
 * and nowhere else. Pasted codes and keys are read straight into the flow and
 * never logged.
 */
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  ANTHROPIC_EXTRA_USAGE_NOTE,
  bindDefaultChatModelIfUnset,
  type AuthInteraction,
  type AuthPrompt,
  type AuthType,
  type LoginRuntime,
} from "./auth.js";
import { loadConfig, type DaemonConfigOverrides } from "./config.js";
import { scrubProviderEnv } from "./env-scrub.js";
import { GhostRegistry, ghostPaths, type Ghost } from "./ghosts.js";
import { ghostAuthPath, ghostModelsPath } from "./models.js";
import { createGhostOmpRuntime } from "./omp-runtime.js";

const USAGE = `ghostd login — sign a ghost into a model provider

Usage:
  ghostd login [<ghost>] [--provider <id>] [--api-key | --oauth] [options]

Options:
  --provider <id>      Provider to log into (e.g. openai-codex, openrouter).
                       Prompted from the list when omitted.
      --api-key        Use the api-key flow (paste a key) instead of OAuth.
      --oauth          Force the OAuth flow (the default when both are offered).
      --ghosts-root <dir>  Directory holding one sub-directory per ghost.
      --config <file>  Config file (default ~/.config/ghost/config.json).
      --offline        Forbid OMP's catalogue network calls.
  -h, --help           Show this message.
`;

interface LoginArgs {
  ghost?: string;
  provider?: string;
  authType?: AuthType;
  overrides: DaemonConfigOverrides;
  offline: boolean;
  help: boolean;
}

function parseLoginArgs(argv: string[]): LoginArgs {
  const overrides: DaemonConfigOverrides = {};
  const args: LoginArgs = { overrides, offline: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} requires a value.`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--provider":
        args.provider = value();
        break;
      case "--api-key":
        args.authType = "api_key";
        break;
      case "--oauth":
        args.authType = "oauth";
        break;
      case "--ghosts-root":
        overrides.ghostsRoot = value();
        break;
      case "--config":
        overrides.configPath = value();
        break;
      case "--offline":
        args.offline = true;
        overrides.offline = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        if (args.ghost !== undefined) throw new Error(`Unexpected argument: ${arg}`);
        args.ghost = arg;
    }
  }
  return args;
}

function out(line = ""): void {
  stdout.write(`${line}\n`);
}

async function resolveGhost(rl: Interface, registry: GhostRegistry, requested?: string): Promise<Ghost> {
  if (requested !== undefined) return registry.get(requested);
  const ghosts = registry.list();
  if (ghosts.length === 0) throw new Error("No ghosts yet. Create one first.");
  if (ghosts.length === 1) return ghosts[0] as Ghost;
  out("Which ghost?");
  ghosts.forEach((ghost, i) => out(`  ${i + 1}. ${ghost.name}`));
  const answer = (await rl.question("> ")).trim();
  const byIndex = Number(answer);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= ghosts.length) {
    return ghosts[byIndex - 1] as Ghost;
  }
  const byName = ghosts.find((ghost) => ghost.name === answer);
  if (!byName) throw new Error(`No ghost matching ${JSON.stringify(answer)}.`);
  return byName;
}

interface LoginProviderOption {
  id: string;
  name: string;
  authType: AuthType;
  subscription: boolean;
  billingNote?: string;
}

function loginableProviders(runtime: LoginRuntime): LoginProviderOption[] {
  const options: LoginProviderOption[] = [];
  for (const provider of runtime.getProviders()) {
    if (provider.auth.oauth) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "oauth",
        subscription: provider.id === "anthropic"
          ? false
          : provider.auth.oauth.isSubscription ?? false,
        ...(provider.id === "anthropic"
          ? { billingNote: ANTHROPIC_EXTRA_USAGE_NOTE }
          : {}),
      });
    }
    if (provider.auth.apiKey?.login) {
      options.push({ id: provider.id, name: provider.name, authType: "api_key", subscription: false });
    }
  }
  return options.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType));
}

async function resolveProvider(
  rl: Interface,
  runtime: LoginRuntime,
  args: LoginArgs,
): Promise<LoginProviderOption> {
  const all = loginableProviders(runtime);
  let candidates = all;
  if (args.provider !== undefined) candidates = candidates.filter((p) => p.id === args.provider);
  if (args.authType !== undefined) candidates = candidates.filter((p) => p.authType === args.authType);

  if (args.provider !== undefined) {
    if (candidates.length === 0) {
      throw new Error(`No provider ${JSON.stringify(args.provider)} offering the requested login.`);
    }
    // Prefer OAuth when a provider offers both and no type was forced.
    return candidates.find((p) => p.authType === "oauth") ?? (candidates[0] as LoginProviderOption);
  }

  out("Sign in to which provider?");
  candidates.forEach((provider, i) =>
    out(`  ${i + 1}. ${provider.name} (`
      + `${provider.authType}`
      + `${provider.subscription ? ", subscription" : ""}`
      + `${provider.billingNote ? `, ${provider.billingNote}` : ""}`
      + ")"),
  );
  const answer = (await rl.question("> ")).trim();
  const byIndex = Number(answer);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= candidates.length) {
    return candidates[byIndex - 1] as LoginProviderOption;
  }
  const byId = candidates.find((provider) => provider.id === answer);
  if (!byId) throw new Error(`No provider matching ${JSON.stringify(answer)}.`);
  return byId;
}

function terminalInteraction(rl: Interface): AuthInteraction {
  return {
    notify: (event) => {
      switch (event.type) {
        case "auth_url":
          out("\nOpen this URL to sign in:");
          out(`  ${event.url}`);
          if (event.instructions) out(event.instructions);
          break;
        case "device_code":
          out(`\nGo to ${event.verificationUri} and enter the code:`);
          out(`  ${event.userCode}`);
          out("Waiting for you to authorize...");
          break;
        case "info":
          out(event.message);
          for (const link of event.links ?? []) out(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
          break;
        case "progress":
          out(event.message);
          break;
      }
    },
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      const options = prompt.signal ? { signal: prompt.signal } : {};
      if (prompt.type === "select") {
        out(prompt.message);
        prompt.options.forEach((option, i) =>
          out(`  ${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
        );
        const answer = (await rl.question("> ", options)).trim();
        const byIndex = Number(answer);
        if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= prompt.options.length) {
          return (prompt.options[byIndex - 1] as { id: string }).id;
        }
        const match = prompt.options.find((option) => option.id === answer);
        if (!match) throw new Error("That is not one of the offered options.");
        return match.id;
      }
      const query = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
      return (await rl.question(query, options)).trim();
    },
  };
}

export async function loginCommand(argv: string[]): Promise<number> {
  let args: LoginArgs;
  try {
    args = parseLoginArgs(argv);
  } catch (error) {
    stdout.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  // Same posture as the daemon: a login should draw only on the flow, never on
  // an ambient provider key that happens to be in the environment.
  scrubProviderEnv(process.env, { offline: args.offline });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const config = loadConfig(args.overrides);
    const registry = new GhostRegistry(config.ghostsRoot);
    const ghost = await resolveGhost(rl, registry, args.ghost);
    const paths = ghostPaths(ghost.dir);
    const runtime = await createGhostOmpRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.agentDir),
      allowModelNetwork: !config.offline,
    });
    const choice = await resolveProvider(rl, runtime, args);

    out(`\nSigning ${ghost.name} in to ${choice.name} (${choice.authType})...`);
    await runtime.login(choice.id, choice.authType, terminalInteraction(rl));

    const bound = await bindDefaultChatModelIfUnset(paths.agentDir, runtime, choice.id);
    out(`\n✓ ${ghost.name} is signed in to ${choice.name}.`);
    if (bound) out(`  Chat model set to ${bound.provider}/${bound.modelId}.`);
    else out("  Pick a model in the shell, or set roles.chat_model in models.json.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`ghostd login: ${message}\n`);
    return 1;
  } finally {
    rl.close();
  }
}
