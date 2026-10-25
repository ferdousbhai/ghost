#!/usr/bin/env bash
set -euo pipefail

# Every manifest that carries the release version, package.json first.
manifests=(
  package.json
  packages/daemon/package.json
  packages/shell/package.json
  packages/shell/qml/manifest.json
)
usage='verify-release-version.sh <source-root> | --manifests | --valid <version>'
if [[ "${1:-}" == --manifests ]]; then
  printf '%s\n' "${manifests[@]}"
  exit
fi
if [[ "${1:-}" == --valid ]]; then
  # A bare word: bun would take a leading "--" argument as its own flag.
  args=(valid "${2:?usage: $usage}")
else
  source_root="${1:?usage: $usage}"
  args=("$(realpath -e -- "$source_root")" "${manifests[@]}")
fi

bun -e '
import { join } from "node:path";

/** x.y.z with no leading zeros, each part at most 65535, and not 0.0.0. */
function isReleaseVersion(version) {
  const components = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version)?.slice(1).map(Number);
  return !!components && components.every((component) => component <= 65535)
    && components.some((component) => component !== 0);
}

if (process.argv[1] === "valid") {
  if (isReleaseVersion(process.argv[2])) process.exit(0);
  console.error(`not a release version: ${JSON.stringify(process.argv[2])}`);
  process.exit(1);
}

const [sourceRoot, ...manifests] = process.argv.slice(1);

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
if (!isReleaseVersion(releaseVersion)) {
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
' "${args[@]}"
