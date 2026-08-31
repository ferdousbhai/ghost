import {
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
  for (const [name, peerVersion] of Object.entries(CLAUDE_AGENT_SDK_PEERS)) {
    const peerRoot = join(installRoot, "node_modules", ...name.split("/"));
    mkdirSync(peerRoot, { recursive: true });
    writeFileSync(join(peerRoot, "package.json"), JSON.stringify({
      name,
      version: peerVersion,
      main: "index.js",
    }));
    writeFileSync(join(peerRoot, "index.js"), "module.exports = {};\n");
  }
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
    for (const [name, version] of Object.entries(CLAUDE_AGENT_SDK_PEERS)) {
      const peerRoot = join(fixture.installRoot, "node_modules", ...name.split("/"));
      mkdirSync(peerRoot, { recursive: true });
      writeFileSync(join(peerRoot, "package.json"), JSON.stringify({
        name,
        version,
        main: "index.js",
      }));
      writeFileSync(join(peerRoot, "index.js"), "module.exports = {};\n");
    }
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
