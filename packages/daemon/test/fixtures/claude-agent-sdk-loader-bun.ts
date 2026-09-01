import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_AGENT_SDK_PEERS,
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "../../src/claude-agent-sdk-loader.js";

const [scenario, ownerHome, dataHome] = process.argv.slice(2);
if (!scenario || !ownerHome || !dataHome) {
  throw new Error("usage: claude-agent-sdk-loader-bun.ts <scenario> <owner-home> <data-home>");
}

const installRoot = join(
  dataHome,
  "ghost",
  "claude-agent-sdk",
  CLAUDE_AGENT_SDK_VERSION,
);
const packageRoot = join(
  installRoot,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
);

function writePackage(revision: string, missingDependency = false): void {
  rmSync(packageRoot, { recursive: true, force: true });
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

function revisionOf(sdk: ClaudeAgentSdkModule): string {
  return (sdk.query as unknown as () => string)();
}

async function rejected(loader: ClaudeAgentSdkLoader): Promise<Error> {
  try {
    await loader.load();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`loader rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("loader unexpectedly succeeded");
}

const loader = new ClaudeAgentSdkLoader({ ownerHome, xdgDataHome: dataHome });

switch (scenario) {
  case "loaded-replace": {
    if (revisionOf(await loader.load()) !== "v1") throw new Error("initial module was not v1");
    writePackage("v2");
    const first = await rejected(loader);
    const second = await rejected(loader);
    if (!/restart-required.*restart ghostd/s.test(first.message) || second !== first) {
      throw new Error(`replacement did not persist restart-required: ${first.message}`);
    }
    console.log("replacement blocked stale v1 and requires restart");
    break;
  }
  case "failed-import-repair": {
    const first = await rejected(loader);
    if (!/restart-required.*failed graph.*restart ghostd/s.test(first.message)) {
      throw new Error(`import failure did not require restart: ${first.message}`);
    }
    writeFileSync(join(packageRoot, "dependency.mjs"), 'export const revision = "v2";\n');
    const second = await rejected(loader);
    if (second !== first) throw new Error("import failure did not persist its restart state");
    console.log("repaired failed graph remains restart-required");
    break;
  }
  case "missing-install": {
    const missing = await rejected(loader);
    if (!/not installed/.test(missing.message) || /restart-required/.test(missing.message)) {
      throw new Error(`pre-import validation was not retryable: ${missing.message}`);
    }
    writePackage("v1");
    if (revisionOf(await loader.load()) !== "v1") {
      throw new Error("same loader did not accept a pre-import repair");
    }
    console.log("pre-import repair loaded without restart");
    break;
  }
  case "load-v2": {
    if (revisionOf(await loader.load()) !== "v2") throw new Error("fresh loader did not load v2");
    console.log("fresh loader loaded v2");
    break;
  }
  default:
    throw new Error(`unknown scenario: ${scenario}`);
}
