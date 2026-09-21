import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface BunMetafile {
  inputs: Record<string, unknown>;
}

interface PackageIdentity {
  name: string;
  version: string;
  license: string;
  root: string;
}

const [sourceRootArg, runtimeRootArg, ...metafileArgs] = process.argv.slice(2);
if (!sourceRootArg || !runtimeRootArg || metafileArgs.length === 0) {
  throw new Error(
    "usage: stage-runtime-licenses.ts <source-root> <runtime-root> <metafile>...",
  );
}

const sourceRoot = resolve(sourceRootArg);
const runtimeRoot = resolve(runtimeRootArg);
const licensesRoot = join(runtimeRoot, "licenses");
const fallbackRoot = join(sourceRoot, "packages", "daemon", "scripts", "runtime-licenses");

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function packageForInput(input: string): PackageIdentity {
  let current = dirname(resolve(sourceRoot, input));
  while (pathWithin(sourceRoot, current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      const manifest = readJson(manifestPath);
      if (typeof manifest.name === "string"
        && typeof manifest.version === "string"
        && typeof manifest.license === "string") {
        return {
          name: manifest.name,
          version: manifest.version,
          license: manifest.license,
          root: current,
        };
      }
    }
    if (current === sourceRoot) break;
    current = dirname(current);
  }
  throw new Error(`could not resolve bundled package identity for ${input}`);
}

function validateIdentity(pkg: PackageIdentity): void {
  const npmName = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;
  const token = /^[^\t\r\n/]+$/;
  if (!npmName.test(pkg.name)
    || !token.test(pkg.version)
    || !token.test(pkg.license)) {
    throw new Error(`invalid bundled package identity: ${JSON.stringify(pkg)}`);
  }
}

function licenseFiles(pkg: PackageIdentity): Array<{ source: string; name: string }> {
  const matches = readdirSync(pkg.root, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && /^(?:licen[cs]e|copying|notice)(?:[-.].*)?$/i.test(entry.name))
    .map((entry) => ({ source: join(pkg.root, entry.name), name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (matches.length > 0) return matches;
  if (pkg.name.startsWith("@earendil-works/") && pkg.version === "0.86.1") {
    return [{
      source: join(fallbackRoot, "earendil-pi.LICENSE"),
      name: "LICENSE",
    }];
  }
  if (pkg.name === "ignore" && pkg.version === "7.0.5") {
    return [{
      source: join(fallbackRoot, "ignore.LICENSE-MIT"),
      name: "LICENSE-MIT",
    }];
  }
  // Pulled in by @anthropic-ai/sdk through pi-ai. Its npm metadata says MIT,
  // but the published commit's repository carries only the root Apache-2.0
  // LICENSE, so that file is what ships.
  if (pkg.name === "standardwebhooks" && pkg.version === "1.1.1") {
    return [{
      source: join(fallbackRoot, "standardwebhooks.LICENSE"),
      name: "LICENSE",
    }];
  }
  throw new Error(`bundled package has no license file: ${pkg.name}@${pkg.version}`);
}

const packages = new Map<string, PackageIdentity>();
for (const metafilePath of metafileArgs) {
  const metafile = readJson(resolve(metafilePath)) as unknown as BunMetafile;
  if (!metafile.inputs || typeof metafile.inputs !== "object") {
    throw new Error(`invalid Bun metafile: ${metafilePath}`);
  }
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/");
    if (!normalized.includes("node_modules/")) continue;
    const pkg = packageForInput(input);
    validateIdentity(pkg);
    const key = `${pkg.name}\0${pkg.version}`;
    const existing = packages.get(key);
    if (existing && (existing.root !== pkg.root || existing.license !== pkg.license)) {
      throw new Error(`ambiguous bundled package identity: ${pkg.name}@${pkg.version}`);
    }
    packages.set(key, pkg);
  }
}

for (const bundle of [join(runtimeRoot, "lib", "ghostd.js"), join(runtimeRoot, "lib", "ghost.js")]) {
  const bytes = readFileSync(bundle, "utf8");
  for (const marker of [
    "Use is subject to the Legal Agreements outlined here",
    "Want to see the unminified source? We're hiring!",
    "// Version: 0.3.170",
  ]) {
    if (bytes.includes(marker)) {
      throw new Error(`Claude Agent SDK source marker entered ${bundle}`);
    }
  }
}

mkdirSync(join(licensesRoot, "ghost"), { recursive: true, mode: 0o755 });
copyFileSync(join(sourceRoot, "LICENSE"), join(licensesRoot, "ghost", "LICENSE"));
copyFileSync(
  join(sourceRoot, "THIRD_PARTY_NOTICES.md"),
  join(licensesRoot, "ghost", "THIRD_PARTY_NOTICES.md"),
);

const version = readJson(join(sourceRoot, "package.json")).version;
if (typeof version !== "string") throw new Error("Ghost package version is invalid");
const rows = [
  "format=ghost-bundled-licenses/v1",
  `ghost\tghost-workspace\t${version}\tApache-2.0\tlicenses/ghost/LICENSE,licenses/ghost/THIRD_PARTY_NOTICES.md`,
];

const ordered = [...packages.values()].sort((a, b) =>
  a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
for (const pkg of ordered) {
  const destination = join(licensesRoot, "npm", ...pkg.name.split("/"), pkg.version);
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  const installed: string[] = [];
  for (const license of licenseFiles(pkg)) {
    const output = join(destination, license.name);
    copyFileSync(license.source, output);
    chmodSync(output, 0o644);
    installed.push(relative(runtimeRoot, output));
  }
  rows.push(`npm\t${pkg.name}\t${pkg.version}\t${pkg.license}\t${installed.join(",")}`);
}

writeFileSync(join(runtimeRoot, "BUNDLED-LICENSES"), `${rows.join("\n")}\n`, {
  mode: 0o644,
});
for (const directory of [licensesRoot, join(licensesRoot, "ghost")]) {
  chmodSync(directory, 0o755);
}
for (const file of [
  join(licensesRoot, "ghost", "LICENSE"),
  join(licensesRoot, "ghost", "THIRD_PARTY_NOTICES.md"),
]) {
  chmodSync(file, 0o644);
}
