import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pi ships prompt text as Bun-native `.md` imports. Vitest only needs these
  // modules to resolve while exercising the extension SDK surface.
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
    name: "bun-import-meta-dir",
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
      // Pi imports this browser script with Bun's `{ type: "file" }`. Vite
      // would execute it in the test worker instead of returning its path.
      if (id.endsWith("/src/export/html/template.js")) {
        return `export default ${JSON.stringify(id)};`;
      }
      return null;
    },
    transform(source, id) {
      if (id.includes("/src/export/html/template.js")) {
        return `export default ${JSON.stringify(id.split("?")[0])};`;
      }
      if (!source.includes("import.meta.dir")) return null;
      // Bun supplies import.meta.dir; Vitest's Vite transform does not.
      return source.replaceAll(
        "import.meta.dir",
        "new URL('.', import.meta.url).pathname",
      );
    },
  }],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
