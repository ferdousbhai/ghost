#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: verify-release-version.sh <source-root>}"
source_root="$(realpath -e -- "$source_root")"

bun -e '
import { join } from "node:path";

const sourceRoot = process.argv[1];
const manifests = [
  "package.json",
  "packages/daemon/package.json",
  "packages/extensions/package.json",
  "packages/shell/package.json",
  "packages/chromium-extension/package.json",
  "packages/chromium-extension/extension/manifest.json",
  "packages/shell/qml/manifest.json",
];

const versions = [];
for (const manifest of manifests) {
  let document;
  try {
    document = await Bun.file(join(sourceRoot, manifest)).json();
  } catch {
    console.error(`${manifest} is not valid JSON`);
    process.exit(1);
  }
  if (
    document === null
    || typeof document !== "object"
    || Array.isArray(document)
    || typeof document.version !== "string"
    || document.version.length === 0
  ) {
    console.error(`${manifest} has no string version`);
    process.exit(1);
  }
  versions.push([manifest, document.version]);
}

const releaseVersion = versions[0][1];
const releaseMatch = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
  releaseVersion,
);
const releaseComponents = releaseMatch?.slice(1).map(Number);
if (
  !releaseComponents
  || releaseComponents.some((component) => component > 65535)
  || releaseComponents.every((component) => component === 0)
) {
  console.error(`package.json has invalid release version ${JSON.stringify(releaseVersion)}`);
  process.exit(1);
}

let mismatched = false;
for (const [manifest, version] of versions.slice(1)) {
  if (version === releaseVersion) continue;
  console.error(`${manifest} version ${version} does not match release version ${releaseVersion}`);
  mismatched = true;
}
if (mismatched) process.exit(1);
process.stdout.write(`${releaseVersion}\n`);
' "$source_root"
