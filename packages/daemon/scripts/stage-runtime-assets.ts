import {
  chmodSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface BunMetafile {
  inputs: Record<string, unknown>;
}

const [sourceRootArg, runtimeRootArg, daemonMetafileArg] = process.argv.slice(2);
if (!sourceRootArg || !runtimeRootArg || !daemonMetafileArg) {
  throw new Error(
    "usage: stage-runtime-assets.ts <source-root> <runtime-root> <daemon-metafile>",
  );
}

const sourceRoot = realpathSync(resolve(sourceRootArg));
const runtimeRoot = resolve(runtimeRootArg);
const daemonBundle = join(runtimeRoot, "lib", "ghostd.js");
const metafile = JSON.parse(readFileSync(resolve(daemonMetafileArg), "utf8")) as BunMetafile;

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const photonEntries = Object.keys(metafile.inputs).filter((input) =>
  input.replaceAll("\\", "/").endsWith(
    "/node_modules/@silvia-odwyer/photon-node/photon_rs.js",
  ));
if (photonEntries.length !== 1) {
  throw new Error(`expected one bundled Photon entry, found ${photonEntries.length}`);
}

const photonRoot = realpathSync(dirname(resolve(sourceRoot, photonEntries[0] as string)));
if (!pathWithin(sourceRoot, photonRoot)) {
  throw new Error(`bundled Photon package escapes the source closure: ${photonRoot}`);
}
const manifest = JSON.parse(readFileSync(join(photonRoot, "package.json"), "utf8")) as {
  name?: unknown;
  version?: unknown;
};
if (manifest.name !== "@silvia-odwyer/photon-node" || manifest.version !== "0.3.4") {
  throw new Error(
    `unexpected bundled Photon identity: ${String(manifest.name)}@${String(manifest.version)}`,
  );
}

const wasmSource = join(photonRoot, "photon_rs_bg.wasm");
const wasmState = lstatSync(wasmSource);
if (!wasmState.isFile() || wasmState.isSymbolicLink() || wasmState.size <= 0
  || wasmState.size > 4 * 1024 * 1024) {
  throw new Error(`Photon WASM is not a bounded regular file: ${wasmSource}`);
}

const embeddedDirectory = JSON.stringify(photonRoot);
const bundle = readFileSync(daemonBundle, "utf8");
const parts = bundle.split(embeddedDirectory);
if (parts.length !== 2) {
  throw new Error(
    `expected one build-root Photon directory in ghostd.js, found ${parts.length - 1}`,
  );
}
const rebased = parts.join("import.meta.dir");
if (rebased.includes(sourceRoot)) {
  throw new Error("ghostd.js retains an absolute source-root path after asset rebasing");
}
writeFileSync(daemonBundle, rebased, { mode: 0o644 });
const clientBundle = readFileSync(join(runtimeRoot, "lib", "ghost.js"), "utf8");
if (clientBundle.includes(sourceRoot)) {
  throw new Error("ghost.js retains an absolute source-root path");
}

const wasmDestination = join(runtimeRoot, "lib", "photon_rs_bg.wasm");
copyFileSync(wasmSource, wasmDestination);
chmodSync(wasmDestination, 0o644);
