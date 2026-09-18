import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/stage-runtime-assets.ts", import.meta.url));
let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function fixture(bundle: (literal: string) => string) {
  scratch = mkdtempSync(join(tmpdir(), "ghost-runtime-assets-"));
  const photon = join(scratch, "node_modules/@silvia-odwyer/photon-node");
  const runtime = join(scratch, "runtime");
  mkdirSync(photon, { recursive: true });
  mkdirSync(join(runtime, "lib"), { recursive: true });
  writeFileSync(join(photon, "package.json"), JSON.stringify({
    name: "@silvia-odwyer/photon-node",
    version: "0.3.4",
  }));
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  writeFileSync(join(photon, "photon_rs_bg.wasm"), wasm);
  writeFileSync(join(runtime, "lib/ghostd.js"), bundle(JSON.stringify(photon)));
  writeFileSync(join(runtime, "lib/ghost.js"), "console.log('client');");
  const meta = join(scratch, "meta.json");
  writeFileSync(meta, JSON.stringify({
    inputs: { "./node_modules/@silvia-odwyer/photon-node/photon_rs.js": {} },
  }));
  return {
    runtime,
    wasm,
    stage: () => execFileSync("bun", [script, scratch as string, runtime, meta], { stdio: "pipe" }),
  };
}

it.each([
  'var __dirname = ROOT;\nconsole.log(__dirname);',
  'var __dirname=ROOT,a={};console.log(__dirname,a);',
])("rebases Photon independently of bundle formatting: %s", (template) => {
  const { runtime, wasm, stage } = fixture((literal) => template.replace("ROOT", literal));
  stage();
  expect(readFileSync(join(runtime, "lib/ghostd.js"), "utf8"))
    .toBe(template.replace("ROOT", "import.meta.dir"));
  expect(readFileSync(join(runtime, "lib/photon_rs_bg.wasm"))).toEqual(wasm);
});

it.each([0, 2])("rejects an ambiguous Photon directory (%i occurrences)", (count) => {
  const { stage } = fixture((literal) => Array(count).fill(`var dir=${literal};`).join(""));
  expect(stage).toThrow(`expected one build-root Photon directory in ghostd.js, found ${count}`);
});

it("still rejects other build-root paths", () => {
  const { stage } = fixture((literal) => `var dir=${literal};var other=${JSON.stringify(scratch)};`);
  expect(stage).toThrow("ghostd.js retains an absolute source-root path");
});
