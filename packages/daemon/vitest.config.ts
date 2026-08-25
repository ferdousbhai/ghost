import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const EXPECTED_OMP_VERSION = "18.0.3";
const OMP_WRAPPER_FILE = "src/extensibility/extensions/wrapper.ts";
const OMP_WRAPPER_NEEDLE = "\t\tapplyToolProxy(registeredTool.definition, this);";
const OMP_WRAPPER_REPLACEMENT =
  "\t\tObject.defineProperties(this, { renderCall: { value: undefined, writable: true, configurable: true }, renderResult: { value: undefined, writable: true, configurable: true }, loadMode: { value: undefined, writable: true, configurable: true } });\n"
  + OMP_WRAPPER_NEEDLE;

function ompPatchError(detail: string): Error {
  return new Error(
    `Ghost's Vitest patch for ${OMP_WRAPPER_FILE} expects `
      + `@oh-my-pi/pi-coding-agent ${EXPECTED_OMP_VERSION}. ${detail} `
      + "Re-check RegisteredToolAdapter's renderCall, renderResult, and loadMode class fields "
      + "and their initialization order around applyToolProxy before updating this guard.",
  );
}

let ompPackagePath: string;
try {
  const resolveImport = Reflect.get(import.meta, "resolve") as ImportMeta["resolve"];
  ompPackagePath = fileURLToPath(new URL(
    "../package.json",
    resolveImport.call(import.meta, "@oh-my-pi/pi-coding-agent/sdk"),
  ));
} catch (error) {
  throw ompPatchError(`Could not resolve the installed package: ${String(error)}.`);
}
let ompPackage: unknown;
try {
  ompPackage = JSON.parse(readFileSync(ompPackagePath, "utf8"));
} catch (error) {
  throw ompPatchError(
    `Could not read the installed package metadata at ${ompPackagePath}: ${String(error)}.`,
  );
}
const installedOmpVersion = typeof ompPackage === "object"
  && ompPackage !== null
  && "version" in ompPackage
  && typeof ompPackage.version === "string"
  ? ompPackage.version
  : undefined;
if (installedOmpVersion !== EXPECTED_OMP_VERSION) {
  throw ompPatchError(
    `Installed version: ${installedOmpVersion ?? "missing package version"}.`,
  );
}

export default defineConfig({
  assetsInclude: [
    "**/*.md",
    "**/*.html",
    "**/*.sh",
    "**/*.applescript",
    "**/*.lark",
    "**/*.jl",
    "**/*.rb",
    "**/*.py",
    "**/*.txt",
  ],
  plugins: [{
    name: "omp-bun-loaders",
    enforce: "pre",
    async resolveId(source, importer) {
      if (
        ["./template.js", "./tool-views.generated.js"].includes(source)
        && importer?.includes("/src/export/html/index.ts")
      ) {
        return `\0ghost-omp-file:${source}`;
      }
      if (/\.(?:md|sh|applescript|lark|jl|rb|py|txt)$/.test(source)) {
        return this.resolve(`${source}?raw`, importer, { skipSelf: true });
      }
      return null;
    },
    load(id) {
      if (id.startsWith("\0ghost-omp-file:")) {
        return `export default ${JSON.stringify(`/unused/${id.slice("\0ghost-omp-file:".length)}`)};`;
      }
      return null;
    },
    transform(source, id) {
      if (id.includes("/src/export/html/template.js")) {
        return `export default ${JSON.stringify(id.split("?")[0])};`;
      }
      if (id.endsWith("/src/extensibility/extensions/wrapper.ts")) {
        // Bun's native TS loader materializes optional class fields; Vite's
        // transform erases them. OMP assigns those fields after installing
        // lazy proxies, so preserve Bun's runtime shape inside Vitest.
        const matches = source.split(OMP_WRAPPER_NEEDLE).length - 1;
        if (matches !== 1) {
          throw ompPatchError(`The exact transform needle matched ${matches} times in ${id}.`);
        }
        return source.replace(OMP_WRAPPER_NEEDLE, OMP_WRAPPER_REPLACEMENT);
      }
      if (!source.includes("import.meta.dir")) return null;
      return source.replaceAll(
        "import.meta.dir",
        "new URL('.', import.meta.url).pathname",
      );
    },
  }],
  test: {
    include: ["test/**/*.test.ts"],
    // Session-host and server tests each stand up a real pi AgentSession
    // against a local mock provider; give them room without being generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // OMP's model runtime and session storage are process-global in places
    // (env, jiti module cache); run files serially so tests never race.
    fileParallelism: false,
    // Bun-native dependencies (SQLite/WebSocket) must stay in the Bun host;
    // Vitest's default fork pool relaunches workers through Node semantics.
    pool: "threads",
  },
});
