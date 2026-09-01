import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_AGENT_SDK_PEERS,
  CLAUDE_AGENT_SDK_VERSION,
} from "../src/claude-agent-sdk-loader.js";

const worker = fileURLToPath(
  new URL("./fixtures/claude-agent-sdk-loader-bun.ts", import.meta.url),
);

interface Fixture {
  ownerHome: string;
  dataHome: string;
  installRoot: string;
}

function fixture(): Fixture {
  const ownerHome = mkdtempSync(join(tmpdir(), "ghost-claude-sdk-bun-"));
  const dataHome = join(ownerHome, "data");
  return {
    ownerHome,
    dataHome,
    installRoot: join(dataHome, "ghost", "claude-agent-sdk", CLAUDE_AGENT_SDK_VERSION),
  };
}

function writePackage(installRoot: string, revision: string, missingDependency = false): void {
  const packageRoot = join(
    installRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
  );
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: CLAUDE_AGENT_SDK_PACKAGE,
    version: CLAUDE_AGENT_SDK_VERSION,
  }));
  const revisionSource = missingDependency
    ? 'import { revision } from "./dependency.mjs";'
    : `const revision = ${JSON.stringify(revision)};`;
  writeFileSync(join(packageRoot, "sdk.mjs"), `${revisionSource}
export function query() { return revision; }
export function tool() { return revision; }
export function createSdkMcpServer() { return revision; }
`);
  for (const [name, version] of Object.entries(CLAUDE_AGENT_SDK_PEERS)) {
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
      const entryRoot = join(peerRoot, "dist", "cjs", "server");
      mkdirSync(entryRoot, { recursive: true });
      writeFileSync(join(peerRoot, "dist", "cjs", "package.json"), JSON.stringify({
        type: "commonjs",
      }));
      writeFileSync(join(entryRoot, "mcp.js"), "module.exports = {};\n");
      continue;
    }
    writeFileSync(join(peerRoot, "package.json"), JSON.stringify({
      name,
      version,
      main: "index.js",
    }));
    writeFileSync(join(peerRoot, "index.js"), "module.exports = {};\n");
  }
}

function runWorker(bun: string, scenario: string, input: Fixture): string {
  const result = spawnSync(
    bun,
    [worker, scenario, input.ownerHome, input.dataHome],
    { encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(
      `real Bun loader scenario ${scenario} failed (${result.status}):\n`
        + `${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function withFixture(run: (input: Fixture) => string): string {
  const input = fixture();
  try {
    return run(input);
  } finally {
    rmSync(input.ownerHome, { recursive: true, force: true });
  }
}

export function replacementScenario(bun = process.execPath): string {
  return withFixture((input) => {
    writePackage(input.installRoot, "v1");
    const blocked = runWorker(bun, "loaded-replace", input);
    const fresh = runWorker(bun, "load-v2", input);
    if (!blocked.includes("requires restart") || !fresh.includes("fresh loader loaded v2")) {
      throw new Error(`replacement scenario did not reach both states:\n${blocked}${fresh}`);
    }
    return `${blocked}${fresh}`;
  });
}

export function failedGraphScenario(bun = process.execPath): string {
  return withFixture((input) => {
    writePackage(input.installRoot, "v2", true);
    const blocked = runWorker(bun, "failed-import-repair", input);
    const fresh = runWorker(bun, "load-v2", input);
    if (!blocked.includes("remains restart-required")
      || !fresh.includes("fresh loader loaded v2")) {
      throw new Error(`failed-graph scenario did not reach both states:\n${blocked}${fresh}`);
    }
    return `${blocked}${fresh}`;
  });
}

export function preImportRepairScenario(bun = process.execPath): string {
  return withFixture((input) => {
    const output = runWorker(bun, "missing-install", input);
    if (!output.includes("without restart")) {
      throw new Error(`pre-import repair was not retryable:\n${output}`);
    }
    return output;
  });
}

if (import.meta.main) {
  replacementScenario();
  failedGraphScenario();
  preImportRepairScenario();
  console.log(`Claude SDK real-import integration passed with Bun ${Bun.version}`);
}
