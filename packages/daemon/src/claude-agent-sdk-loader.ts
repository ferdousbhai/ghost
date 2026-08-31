import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.170";
export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

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
  return "pnpm add --dir "
    + `${JSON.stringify(root)} --save-exact `
    + `${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION} `
    + "@anthropic-ai/sdk@0.93.0 @modelcontextprotocol/sdk@1.29.0 zod@4.4.3";
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

  async load(): Promise<ClaudeAgentSdkModule> {
    if (this.restartRequired) throw this.restartRequired;
    if (this.inFlight) return this.inFlight;
    const pending = this.loadChecked();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = undefined;
    }
  }

  private requireRestart(detail: string, cause?: unknown): ClaudeAgentSdkLoadError {
    if (!this.restartRequired) {
      this.restartRequired = new ClaudeAgentSdkLoadError(
        `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} is restart-required: ${detail}. `
          + `Repair the exact private owner-local install if needed with: `
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
          + `${this.installRoot}. Install this private owner-local capability with: `
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

    const statIdentity = (state: typeof rootState) => [
      state.dev,
      state.ino,
      state.size,
      state.mtimeMs,
      state.ctimeMs,
    ];
    const entryIdentity = statIdentity(entryState);
    const fingerprint = JSON.stringify([
      canonicalRoot,
      packageRoot,
      statIdentity(rootState),
      statIdentity(packageRootState),
      statIdentity(packageState),
      entryIdentity,
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
