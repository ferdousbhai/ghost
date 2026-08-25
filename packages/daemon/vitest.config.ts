import { defineConfig } from "vitest/config";

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
        return source.replace(
          "\t\tapplyToolProxy(registeredTool.definition, this);",
          "\t\tObject.defineProperties(this, { renderCall: { value: undefined, writable: true, configurable: true }, renderResult: { value: undefined, writable: true, configurable: true }, loadMode: { value: undefined, writable: true, configurable: true } });\n\t\tapplyToolProxy(registeredTool.definition, this);",
        );
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
