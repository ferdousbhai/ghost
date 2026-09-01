import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_AGENT_SDK_PEERS,
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "../src/claude-agent-sdk-loader.js";

const roots: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): { ownerHome: string; dataHome: string; installRoot: string } {
  const ownerHome = mkdtempSync(join(tmpdir(), "ghost-claude-sdk-owner-"));
  roots.push(ownerHome);
  const dataHome = join(ownerHome, "data");
  return {
    ownerHome,
    dataHome,
    installRoot: join(dataHome, "ghost", "claude-agent-sdk", CLAUDE_AGENT_SDK_VERSION),
  };
}

function fakeSdk(): ClaudeAgentSdkModule {
  return {
    createSdkMcpServer: (() => ({})) as unknown as ClaudeAgentSdkModule["createSdkMcpServer"],
    query: (() => ({})) as unknown as ClaudeAgentSdkModule["query"],
    tool: (() => ({})) as unknown as ClaudeAgentSdkModule["tool"],
  };
}

function writePeerPackage(installRoot: string, name: string, version: string): void {
  const peerRoot = join(installRoot, "node_modules", ...name.split("/"));
  mkdirSync(peerRoot, { recursive: true });
  if (name === "@modelcontextprotocol/sdk") {
    writeFileSync(join(peerRoot, "package.json"), JSON.stringify({
      name,
      version,
      type: "module",
      exports: {
        ".": {
          import: "./dist/esm/index.js",
          require: "./dist/cjs/index.js",
        },
        "./*": {
          import: "./dist/esm/*",
          require: "./dist/cjs/*",
        },
      },
    }));
    for (const format of ["cjs", "esm"] as const) {
      const formatRoot = join(peerRoot, "dist", format);
      const entryRoot = join(formatRoot, "server");
      mkdirSync(entryRoot, { recursive: true });
      writeFileSync(join(formatRoot, "package.json"), JSON.stringify({
        type: format === "cjs" ? "commonjs" : "module",
      }));
      writeFileSync(
        join(entryRoot, "mcp.js"),
        format === "cjs"
          ? "module.exports = { McpServer: class McpServer {} };\n"
          : "export class McpServer {}\n",
      );
    }
    return;
  }
  writeFileSync(join(peerRoot, "package.json"), JSON.stringify({
    name,
    version,
    main: "index.js",
  }));
  writeFileSync(join(peerRoot, "index.js"), "module.exports = {};\n");
}

function writePeerPackages(installRoot: string): void {
  for (const [name, peerVersion] of Object.entries(CLAUDE_AGENT_SDK_PEERS)) {
    writePeerPackage(installRoot, name, peerVersion);
  }
}

function mcpCjsEntry(installRoot: string): string {
  return join(
    installRoot,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "cjs",
    "server",
    "mcp.js",
  );
}

function writeSdkPackage(
  installRoot: string,
  version = CLAUDE_AGENT_SDK_VERSION,
): string {
  const packageRoot = join(
    installRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
  );
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: CLAUDE_AGENT_SDK_PACKAGE,
    version,
  }));
  writeFileSync(join(packageRoot, "sdk.mjs"), "export const fixture = true;\n");
  writePeerPackages(installRoot);
  return packageRoot;
}

describe("ClaudeAgentSdkLoader", () => {
  it("coalesces import, revalidates later loads, and caches only the module", async () => {
    const fixture = fixtureRoot();
    const packageRoot = writeSdkPackage(fixture.installRoot);
    const importStarted = deferred<void>();
    const releaseImport = deferred<void>();
    const imported = vi.fn(async (_specifier: string) => {
      importStarted.resolve();
      await releaseImport.promise;
      return fakeSdk();
    });
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    const firstLoad = loader.load();
    const concurrentLoad = loader.load();
    await importStarted.promise;
    expect(imported).toHaveBeenCalledTimes(1);
    releaseImport.resolve();
    const [first, concurrent] = await Promise.all([firstLoad, concurrentLoad]);
    expect(concurrent).toBe(first);
    expect(await loader.load()).toBe(first);
    expect(imported).toHaveBeenCalledTimes(1);
    const specifier = new URL(imported.mock.calls[0]?.[0] as string);
    expect(fileURLToPath(specifier)).toBe(join(packageRoot, "sdk.mjs"));
    expect(specifier.search).toBe("");
  });

  it("aborts one SDK waiter without cancelling or poisoning the shared load", async () => {
    const fixture = fixtureRoot();
    writeSdkPackage(fixture.installRoot);
    const importStarted = deferred<void>();
    const releaseImport = deferred<void>();
    const sdk = fakeSdk();
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: async () => {
        importStarted.resolve();
        await releaseImport.promise;
        return sdk;
      },
    });
    const controller = new AbortController();
    const cancelled = loader.load(controller.signal);
    await importStarted.promise;
    controller.abort();

    await expect(cancelled).rejects.toThrow("SDK load was aborted");
    const surviving = loader.load();
    releaseImport.resolve();
    await expect(surviving).resolves.toBe(sdk);
    await expect(loader.load()).resolves.toBe(sdk);
  });

  it("rejects a relative owner home and ignores a relative XDG data home", async () => {
    expect(() => new ClaudeAgentSdkLoader({ ownerHome: "relative" })).toThrow(
      /ownerHome must be absolute/,
    );

    const fixture = fixtureRoot();
    const fallback = join(
      fixture.ownerHome,
      ".local",
      "share",
      "ghost",
      "claude-agent-sdk",
      CLAUDE_AGENT_SDK_VERSION,
    );
    writeSdkPackage(fallback);
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: "relative",
      importModule: async () => fakeSdk(),
    });

    expect(loader.installRoot).toBe(fallback);
    await expect(loader.load()).resolves.toBeDefined();
  });

  it("fails loudly when missing and retries after an owner install", async () => {
    const fixture = fixtureRoot();
    const imported = vi.fn(async (_specifier: string) => fakeSdk());
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    const failures = await Promise.allSettled([loader.load(), loader.load()]);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    const reasons = failures.map((result) =>
      result.status === "rejected" ? result.reason : undefined);
    expect(reasons[0]).toBe(reasons[1]);
    expect(reasons[0]).toMatchObject({
      message: expect.stringMatching(/not installed.*pnpm add/s),
    });
    writeSdkPackage(fixture.installRoot);
    await expect(loader.load()).resolves.toBeDefined();
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("persists restart-required after removal even when the install is repaired", async () => {
    const fixture = fixtureRoot();
    writeSdkPackage(fixture.installRoot);
    const imported = vi.fn(async (_specifier: string) => fakeSdk());
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    await loader.load();
    rmSync(fixture.installRoot, { recursive: true, force: true });
    const removed = await loader.load().catch((error: unknown) => error);
    expect(removed).toMatchObject({
      message: expect.stringMatching(/restart-required.*restart ghostd/s),
    });
    writeSdkPackage(fixture.installRoot);

    await expect(loader.load()).rejects.toBe(removed);
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("persists restart-required after exact replacement and never returns stale code", async () => {
    const fixture = fixtureRoot();
    const originalRoot = writeSdkPackage(fixture.installRoot);
    const imported = vi.fn(async (_specifier: string) => fakeSdk());
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    await loader.load();
    rmSync(originalRoot, { recursive: true, force: true });
    writeSdkPackage(fixture.installRoot);
    const changed = await loader.load().catch((error: unknown) => error);
    expect(changed).toMatchObject({
      message: expect.stringMatching(/restart-required.*changed after.*restart ghostd/s),
    });

    await expect(loader.load()).rejects.toBe(changed);
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("coalesces an import failure and permanently requires restart", async () => {
    const fixture = fixtureRoot();
    writeSdkPackage(fixture.installRoot);
    const failure = new Error("missing transitive dependency");
    const imported = vi.fn(async (_specifier: string) => {
      throw failure;
    });
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    const failures = await Promise.allSettled([loader.load(), loader.load()]);
    const reasons = failures.map((result) =>
      result.status === "rejected" ? result.reason : undefined);
    expect(reasons[0]).toBe(reasons[1]);
    expect(reasons[0]).toMatchObject({
      message: expect.stringMatching(/restart-required.*failed graph.*restart ghostd/s),
      cause: failure,
    });
    await expect(loader.load()).rejects.toBe(reasons[0]);
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("retries a package mismatch repaired before any import attempt", async () => {
    const fixture = fixtureRoot();
    writeSdkPackage(fixture.installRoot, "0.3.171");
    const imported = vi.fn(async (_specifier: string) => fakeSdk());
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    await expect(loader.load()).rejects.toThrow(/version mismatch.*0\.3\.170.*0\.3\.171/s);
    expect(imported).not.toHaveBeenCalled();
    rmSync(fixture.installRoot, { recursive: true, force: true });
    writeSdkPackage(fixture.installRoot);
    await expect(loader.load()).resolves.toBeDefined();
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched peer before importing the SDK graph", async () => {
    const fixture = fixtureRoot();
    writeSdkPackage(fixture.installRoot);
    const peerRoot = join(fixture.installRoot, "node_modules", "zod");
    writeFileSync(join(peerRoot, "package.json"), JSON.stringify({
      name: "zod",
      version: "4.4.4",
      main: "index.js",
    }));
    const imported = vi.fn(async (_specifier: string) => fakeSdk());
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });

    await expect(loader.load()).rejects.toThrow(
      /peer version mismatch.*zod@4\.4\.3.*zod@4\.4\.4/s,
    );
    expect(imported).not.toHaveBeenCalled();
  });

  it("loads through the MCP subpath when the pinned package root export is absent", async () => {
    const fixture = fixtureRoot();
    const packageRoot = writeSdkPackage(fixture.installRoot);
    writeFileSync(join(packageRoot, "sdk.mjs"), `
export function query() {}
export function tool() {}
export function createSdkMcpServer() {}
`);
    expect(existsSync(join(
      fixture.installRoot,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "cjs",
      "index.js",
    ))).toBe(false);

    const sdk = await new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
    }).load();

    expect(typeof sdk.query).toBe("function");
    expect(typeof sdk.createSdkMcpServer).toBe("function");
  });

  it("rejects invalid MCP subpaths and metadata before import", async () => {
    const cases = [
      "missing",
      "symlinked",
      "outside",
      "missing-metadata",
      "malformed-metadata",
    ] as const;
    for (const scenario of cases) {
      const fixture = fixtureRoot();
      writeSdkPackage(fixture.installRoot);
      const entry = mcpCjsEntry(fixture.installRoot);
      if (scenario === "missing") {
        rmSync(entry);
      } else if (scenario === "symlinked") {
        rmSync(entry);
        const alternate = join(dirname(entry), "alternate.js");
        writeFileSync(alternate, "module.exports = {};\n");
        symlinkSync(alternate, entry);
      } else if (scenario === "outside") {
        rmSync(entry);
        const outside = mkdtempSync(join(tmpdir(), "ghost-claude-mcp-outside-"));
        roots.push(outside);
        const alternate = join(outside, "mcp.js");
        writeFileSync(alternate, "module.exports = {};\n");
        symlinkSync(alternate, entry);
      } else {
        const metadata = join(dirname(dirname(dirname(dirname(entry)))), "package.json");
        if (scenario === "missing-metadata") rmSync(metadata);
        else writeFileSync(metadata, "not json\n");
      }
      const imported = vi.fn(async () => fakeSdk());

      await expect(new ClaudeAgentSdkLoader({
        ownerHome: fixture.ownerHome,
        xdgDataHome: fixture.dataHome,
        importModule: imported,
      }).load()).rejects.toThrow(/peer|subpath|resolv|outside/i);
      expect(imported).not.toHaveBeenCalled();
    }
  });

  it("requires restart when the validated MCP subpath rotates", async () => {
    const fixture = fixtureRoot();
    writeSdkPackage(fixture.installRoot);
    const imported = vi.fn(async () => fakeSdk());
    const loader = new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    });
    await loader.load();
    writeFileSync(mcpCjsEntry(fixture.installRoot), "module.exports = { changed: true };\n");

    const changed = await loader.load().catch((error: unknown) => error);
    expect(changed).toMatchObject({
      message: expect.stringMatching(/restart-required.*changed after/s),
    });
    await expect(loader.load()).rejects.toBe(changed);
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("accepts a pnpm-style in-root link but rejects one outside the install", async () => {
    const fixture = fixtureRoot();
    mkdirSync(fixture.installRoot, { recursive: true });
    const linkedPath = join(
      fixture.installRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
    );
    mkdirSync(dirname(linkedPath), { recursive: true });
    const inRoot = join(fixture.installRoot, ".pnpm", "sdk", "node_modules", "sdk");
    mkdirSync(inRoot, { recursive: true });
    writeFileSync(join(inRoot, "package.json"), JSON.stringify({
      name: CLAUDE_AGENT_SDK_PACKAGE,
      version: CLAUDE_AGENT_SDK_VERSION,
    }));
    writeFileSync(join(inRoot, "sdk.mjs"), "export const fixture = true;\n");
    writePeerPackages(fixture.installRoot);
    symlinkSync(inRoot, linkedPath, "dir");
    const imported = vi.fn(async (_specifier: string) => fakeSdk());
    await expect(new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    }).load()).resolves.toBeDefined();

    rmSync(linkedPath);
    const outside = mkdtempSync(join(tmpdir(), "ghost-claude-sdk-outside-"));
    roots.push(outside);
    writeSdkPackage(outside);
    symlinkSync(join(outside, "node_modules", "@anthropic-ai", "claude-agent-sdk"), linkedPath, "dir");
    await expect(new ClaudeAgentSdkLoader({
      ownerHome: fixture.ownerHome,
      xdgDataHome: fixture.dataHome,
      importModule: imported,
    }).load()).rejects.toThrow(/outside its versioned install root/);
  });
});
