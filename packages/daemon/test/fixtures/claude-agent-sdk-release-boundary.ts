import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_AGENT_SDK_PEERS,
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeAgentSdkLoader,
} from "../../src/claude-agent-sdk-loader.js";

const EXPECTED_GRAPH = {
  "@anthropic-ai/claude-agent-sdk": "0.3.170",
  "@anthropic-ai/sdk": "0.93.0",
  "@modelcontextprotocol/sdk": "1.29.0",
  zod: "4.4.3",
} as const;

function fail(message: string): never {
  throw new Error(`Claude SDK release-boundary fixture: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, description: string): void {
  if (actual !== expected) {
    fail(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertOwnedInstallRoot(loader: ClaudeAgentSdkLoader, dataHome: string): void {
  const expectedRoot = resolve(
    dataHome,
    "ghost",
    "claude-agent-sdk",
    EXPECTED_GRAPH["@anthropic-ai/claude-agent-sdk"],
  );
  assertEqual(loader.installRoot, expectedRoot, "scratch install root");
}

function assertScratchLayout(ownerHome: string, dataHome: string, scratchRoot: string): void {
  const root = resolve(scratchRoot);
  assertEqual(resolve(ownerHome), join(root, "home"), "scratch owner home");
  assertEqual(resolve(dataHome), join(root, "data"), "scratch data home");
  const marker = lstatSync(join(root, ".ghost-claude-sdk-boundary"));
  if (!marker.isFile() || marker.isSymbolicLink()) fail("scratch marker is not a regular file");
}

function verifyContract(sourceRoot: string): void {
  assertEqual(CLAUDE_AGENT_SDK_PACKAGE, "@anthropic-ai/claude-agent-sdk", "SDK package");
  assertEqual(
    CLAUDE_AGENT_SDK_VERSION,
    EXPECTED_GRAPH["@anthropic-ai/claude-agent-sdk"],
    "SDK version",
  );
  assertEqual(
    JSON.stringify(CLAUDE_AGENT_SDK_PEERS),
    JSON.stringify({
      "@anthropic-ai/sdk": EXPECTED_GRAPH["@anthropic-ai/sdk"],
      "@modelcontextprotocol/sdk": EXPECTED_GRAPH["@modelcontextprotocol/sdk"],
      zod: EXPECTED_GRAPH.zod,
    }),
    "SDK peer graph",
  );

  const packageJson = JSON.parse(
    readFileSync(resolve(sourceRoot, "packages/daemon/package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const [name, version] of Object.entries(EXPECTED_GRAPH)) {
    const declared = packageJson.devDependencies?.[name] ?? packageJson.dependencies?.[name];
    assertEqual(declared, version, `daemon package version ${name}`);
  }

  const releaseFixture = JSON.parse(
    readFileSync(
      resolve(sourceRoot, "packaging/release/fixtures/claude-agent-sdk/package.json"),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string> };
  assertEqual(
    JSON.stringify(releaseFixture.dependencies),
    JSON.stringify(EXPECTED_GRAPH),
    "release SDK fixture graph",
  );

  const documentation = readFileSync(resolve(sourceRoot, "docs/claude-code-runtime.md"), "utf8");
  for (const [name, version] of Object.entries(EXPECTED_GRAPH)) {
    if (!documentation.includes(`${name}@${version}`)) {
      fail(`docs/claude-code-runtime.md does not name ${name}@${version}`);
    }
  }

  const runtimeSourceBuilder = readFileSync(
    resolve(sourceRoot, "packaging/release/build-runtime-source.sh"),
    "utf8",
  );
  if (!runtimeSourceBuilder.includes("claude_agent_sdk=external@0.3.170")) {
    fail("runtime source manifest does not declare external@0.3.170");
  }
}

async function expectLoadFailure(loader: ClaudeAgentSdkLoader, pattern: RegExp): Promise<Error> {
  try {
    await loader.load();
  } catch (error) {
    if (!(error instanceof Error) || !pattern.test(error.message)) {
      fail(`unexpected loader error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return error;
  }
  return fail("loader unexpectedly accepted the SDK graph");
}

async function main(): Promise<void> {
  const [mode, ownerHome, dataHome, scratchRoot, sourceRoot] = process.argv.slice(2);
  if (!mode || !ownerHome || !dataHome || !scratchRoot) {
    fail(
      "usage: <contract|missing|installed-remove> <owner-home> <data-home> <scratch-root> [source-root]",
    );
  }

  assertScratchLayout(ownerHome, dataHome, scratchRoot);
  const loader = new ClaudeAgentSdkLoader({ ownerHome, xdgDataHome: dataHome });
  assertOwnedInstallRoot(loader, dataHome);

  if (mode === "contract") {
    if (!sourceRoot) fail("contract mode requires a source root");
    verifyContract(resolve(sourceRoot));
    return;
  }

  if (mode === "missing") {
    if (existsSync(loader.installRoot)) fail("missing mode received an existing SDK root");
    await expectLoadFailure(loader, /Claude Agent SDK .* is not installed/);
    return;
  }

  if (mode === "installed-remove") {
    const sdk = await loader.load();
    if (
      typeof sdk.query !== "function" ||
      typeof sdk.tool !== "function" ||
      typeof sdk.createSdkMcpServer !== "function"
    ) {
      fail("loaded package does not expose the required SDK surface");
    }

    rmSync(loader.installRoot, { recursive: true, force: false });
    const first = await expectLoadFailure(loader, /restart-required:.*restart ghostd/s);
    const second = await expectLoadFailure(loader, /restart-required:.*restart ghostd/s);
    if (first !== second) fail("restart-required failure was not memoized");
    return;
  }

  fail(`unknown mode ${mode}`);
}

await main();
