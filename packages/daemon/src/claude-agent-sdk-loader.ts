import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.170";
export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_PEERS = {
  "@anthropic-ai/sdk": "0.93.0",
  "@modelcontextprotocol/sdk": "1.29.0",
  zod: "4.4.3",
} as const;

const MCP_SDK_PACKAGE = "@modelcontextprotocol/sdk";
const MCP_SDK_ENTRY = `${MCP_SDK_PACKAGE}/server/mcp.js`;
const MCP_SDK_CJS_ENTRY = "dist/cjs/server/mcp.js";

const PACKAGE_JSON_MAX_BYTES = 64 * 1024;

export interface ClaudeAgentSdkModule {
  createSdkMcpServer: typeof createSdkMcpServer;
  query: typeof query;
  tool: typeof tool;
}

export interface ClaudeAgentSdkLoaderOptions {
  ownerHome?: string;
  xdgDataHome?: string;
  importModule?: (specifier: string) => Promise<unknown>;
}

interface ClaudeAgentSdkInstall {
  entryPath: string;
  fingerprint: string;
}

type FileState = Awaited<ReturnType<typeof lstat>>;

function statIdentity(state: FileState): readonly string[] {
  return [state.dev, state.ino, state.size, state.mtimeMs, state.ctimeMs].map(String);
}

export class ClaudeAgentSdkLoadError extends Error {
  readonly _tag = "ClaudeAgentSdkLoadError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeAgentSdkLoadError";
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sdkInstallRoot(ownerHome: string, xdgDataHome: string | undefined): string {
  const dataRoot = xdgDataHome && isAbsolute(xdgDataHome)
    ? resolve(xdgDataHome)
    : join(ownerHome, ".local", "share");
  return join(dataRoot, "ghost", "claude-agent-sdk", CLAUDE_AGENT_SDK_VERSION);
}

function installCommand(root: string): string {
  const packages = [
    `${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`,
    ...Object.entries(CLAUDE_AGENT_SDK_PEERS).map(([name, version]) => `${name}@${version}`),
  ];
  return "pnpm add --dir "
    + `${JSON.stringify(root)} --save-exact ${packages.join(" ")}`;
}

function sdkLoadAborted(): ClaudeAgentSdkLoadError {
  return new ClaudeAgentSdkLoadError("Claude Agent SDK load was aborted.");
}

function awaitSdkLoad(
  pending: Promise<ClaudeAgentSdkModule>,
  signal: AbortSignal | undefined,
): Promise<ClaudeAgentSdkModule> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(sdkLoadAborted());
  return new Promise((resolveLoad, rejectLoad) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      rejectLoad(sdkLoadAborted());
    };
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (sdk) => { signal.removeEventListener("abort", aborted); resolveLoad(sdk); },
      (error: unknown) => { signal.removeEventListener("abort", aborted); rejectLoad(error); },
    );
  });
}

/**
 * Loads the optional Claude Agent SDK from Ghost's one versioned owner-data
 * directory. This is location confinement, not a sandbox from code the same
 * OS owner installed there.
 */
export class ClaudeAgentSdkLoader {
  readonly installRoot: string;
  private readonly importModule: NonNullable<ClaudeAgentSdkLoaderOptions["importModule"]>;
  private loaded?: { sdk: ClaudeAgentSdkModule; fingerprint: string };
  private restartRequired?: ClaudeAgentSdkLoadError;
  private inFlight?: Promise<ClaudeAgentSdkModule>;

  constructor(options: ClaudeAgentSdkLoaderOptions = {}) {
    const ownerHome = options.ownerHome ?? homedir();
    if (!isAbsolute(ownerHome)) throw new TypeError("ownerHome must be absolute");
    this.installRoot = sdkInstallRoot(
      resolve(ownerHome),
      options.xdgDataHome ?? process.env.XDG_DATA_HOME,
    );
    this.importModule = options.importModule ?? ((specifier) => import(specifier));
  }

  load(signal?: AbortSignal): Promise<ClaudeAgentSdkModule> {
    if (signal?.aborted) return Promise.reject(sdkLoadAborted());
    if (this.restartRequired) return Promise.reject(this.restartRequired);
    if (!this.inFlight) {
      const pending = this.loadChecked();
      this.inFlight = pending;
      void pending.then(
        () => { if (this.inFlight === pending) this.inFlight = undefined; },
        () => { if (this.inFlight === pending) this.inFlight = undefined; },
      );
    }
    return awaitSdkLoad(this.inFlight, signal);
  }

  private requireRestart(detail: string, cause?: unknown): ClaudeAgentSdkLoadError {
    if (!this.restartRequired) {
      this.restartRequired = new ClaudeAgentSdkLoadError(
        `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} is restart-required: ${detail}. `
          + `Repair the exact owner-installed runtime boundary if needed with: `
          + `${installCommand(this.installRoot)}. Then restart ghostd before retrying.`,
        cause === undefined ? undefined : { cause },
      );
    }
    return this.restartRequired;
  }

  private async validateInstall(): Promise<ClaudeAgentSdkInstall> {
    const rootState = await lstat(this.installRoot).catch((cause) => {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} is not installed at `
          + `${this.installRoot}. Install this optional owner runtime with: `
          + installCommand(this.installRoot),
        { cause },
      );
    });
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK install root must be a real directory: ${this.installRoot}`,
      );
    }

    const canonicalRoot = await realpath(this.installRoot);
    const packageLink = join(
      this.installRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
    );
    let packageRoot: string;
    try {
      packageRoot = await realpath(packageLink);
    } catch (cause) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} is incomplete at ${this.installRoot}. `
          + `Repair it with: ${installCommand(this.installRoot)}`,
        { cause },
      );
    }
    if (!pathWithin(canonicalRoot, packageRoot)) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK package resolves outside its versioned install root: ${packageLink}`,
      );
    }

    const packageJsonPath = join(packageRoot, "package.json");
    const entryPath = join(packageRoot, "sdk.mjs");
    const [packageRootState, packageState, entryState] = await Promise.all([
      lstat(packageRoot),
      lstat(packageJsonPath),
      lstat(entryPath),
    ]).catch((cause) => {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} is incomplete at `
          + `${this.installRoot}. Repair it with: ${installCommand(this.installRoot)}`,
        { cause },
      );
    });
    if (!packageRootState.isDirectory() || packageRootState.isSymbolicLink()) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK package root is not a real directory: ${packageRoot}`,
      );
    }
    if (!packageState.isFile() || packageState.isSymbolicLink()
      || packageState.size > PACKAGE_JSON_MAX_BYTES) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK package metadata is not a bounded regular file: ${packageJsonPath}`,
      );
    }
    if (!entryState.isFile() || entryState.isSymbolicLink()) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK entry is not a regular file: ${entryPath}`,
      );
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
    } catch (cause) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK package metadata is invalid: ${packageJsonPath}`,
        { cause },
      );
    }
    const identity = manifest as { name?: unknown; version?: unknown };
    if (identity.name !== CLAUDE_AGENT_SDK_PACKAGE
      || identity.version !== CLAUDE_AGENT_SDK_VERSION) {
      throw new ClaudeAgentSdkLoadError(
        `Claude Agent SDK version mismatch at ${packageRoot}: expected `
          + `${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}, found `
          + `${String(identity.name)}@${String(identity.version)}.`,
      );
    }

    const entryIdentity = statIdentity(entryState);
    const requireFromSdk = createRequire(entryPath);
    const peerIdentities: unknown[] = [];
    for (const [peerName, peerVersion] of Object.entries(CLAUDE_AGENT_SDK_PEERS)) {
      const peerSpecifier = peerName === MCP_SDK_PACKAGE ? MCP_SDK_ENTRY : peerName;
      let peerEntry: string;
      try {
        peerEntry = await realpath(requireFromSdk.resolve(peerSpecifier));
      } catch (cause) {
        throw new ClaudeAgentSdkLoadError(
          `Claude Agent SDK peer ${peerName}@${peerVersion} is not resolvable from ${entryPath}.`,
          { cause },
        );
      }
      if (!pathWithin(canonicalRoot, peerEntry)) {
        throw new ClaudeAgentSdkLoadError(
          `Claude Agent SDK peer resolves outside its versioned install root: ${peerName}`,
        );
      }
      let peerRoot: string | undefined;
      let peerManifestPath: string | undefined;
      let peerManifestState: FileState | undefined;
      let cursor = dirname(peerEntry);
      while (pathWithin(canonicalRoot, cursor) && cursor !== canonicalRoot) {
        const candidate = join(cursor, "package.json");
        const candidateState = await lstat(candidate).catch(() => undefined);
        if (candidateState?.isFile() && !candidateState.isSymbolicLink()
          && candidateState.size <= PACKAGE_JSON_MAX_BYTES) {
          try {
            const candidateManifest = JSON.parse(await readFile(candidate, "utf8")) as {
              name?: unknown;
              version?: unknown;
            };
            if (candidateManifest.name === peerName) {
              if (candidateManifest.version !== peerVersion) {
                throw new ClaudeAgentSdkLoadError(
                  `Claude Agent SDK peer version mismatch: expected ${peerName}@${peerVersion}, `
                    + `found ${String(candidateManifest.name)}@${String(candidateManifest.version)}.`,
                );
              }
              peerRoot = cursor;
              peerManifestPath = candidate;
              peerManifestState = candidateState;
              break;
            }
          } catch (cause) {
            if (cause instanceof ClaudeAgentSdkLoadError) throw cause;
          }
        }
        cursor = dirname(cursor);
      }
      if (!peerRoot || !peerManifestPath || !peerManifestState) {
        throw new ClaudeAgentSdkLoadError(
          `Claude Agent SDK peer ${peerName}@${peerVersion} has no matching bounded metadata.`,
        );
      }
      const [peerRootState, peerEntryState] = await Promise.all([
        lstat(peerRoot),
        lstat(peerEntry),
      ]);
      if (!peerRootState.isDirectory() || peerRootState.isSymbolicLink()
        || !peerEntryState.isFile() || peerEntryState.isSymbolicLink()
        || !pathWithin(peerRoot, peerEntry)) {
        throw new ClaudeAgentSdkLoadError(
          `Claude Agent SDK peer ${peerName}@${peerVersion} is not a regular package boundary.`,
        );
      }
      if (peerName === MCP_SDK_PACKAGE) {
        const exactEntry = join(peerRoot, MCP_SDK_CJS_ENTRY);
        const exactState = await lstat(exactEntry).catch(() => undefined);
        const exactCanonical = await realpath(exactEntry).catch(() => undefined);
        if (!exactState?.isFile() || exactState.isSymbolicLink()
          || exactCanonical !== peerEntry) {
          throw new ClaudeAgentSdkLoadError(
            `Claude Agent SDK peer ${peerName}@${peerVersion} has an invalid required subpath.`,
          );
        }
      }
      peerIdentities.push([
        peerName,
        peerVersion,
        peerRoot,
        peerManifestPath,
        peerSpecifier,
        peerEntry,
        statIdentity(peerRootState),
        statIdentity(peerManifestState),
        statIdentity(peerEntryState),
      ]);
    }
    const fingerprint = JSON.stringify([
      canonicalRoot,
      packageRoot,
      statIdentity(rootState),
      statIdentity(packageRootState),
      statIdentity(packageState),
      entryIdentity,
      peerIdentities,
    ]);
    return { entryPath, fingerprint };
  }

  private async loadChecked(): Promise<ClaudeAgentSdkModule> {
    let install: ClaudeAgentSdkInstall;
    try {
      install = await this.validateInstall();
    } catch (error) {
      if (this.loaded) {
        throw this.requireRestart("the loaded install no longer has its exact filesystem identity", error);
      }
      throw error;
    }
    if (this.loaded) {
      if (this.loaded.fingerprint === install.fingerprint) return this.loaded.sdk;
      throw this.requireRestart("the exact install changed after it was loaded");
    }

    let imported: unknown;
    try {
      imported = await this.importModule(pathToFileURL(install.entryPath).href);
    } catch (cause) {
      throw this.requireRestart(
        `the import from ${install.entryPath} failed and Bun may have cached that failed graph`,
        cause,
      );
    }
    let afterImport: ClaudeAgentSdkInstall;
    try {
      afterImport = await this.validateInstall();
    } catch (error) {
      throw this.requireRestart("the exact install became invalid while it was loading", error);
    }
    if (afterImport.fingerprint !== install.fingerprint) {
      throw this.requireRestart("the exact install changed while it was loading");
    }
    const sdk = imported as Partial<ClaudeAgentSdkModule>;
    if (typeof sdk.query !== "function"
      || typeof sdk.tool !== "function"
      || typeof sdk.createSdkMcpServer !== "function") {
      throw this.requireRestart(
        "the imported module does not expose Ghost's required API",
      );
    }
    const loaded = sdk as ClaudeAgentSdkModule;
    this.loaded = { sdk: loaded, fingerprint: install.fingerprint };
    return loaded;
  }
}
