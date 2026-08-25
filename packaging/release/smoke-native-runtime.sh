#!/usr/bin/env bash
set -euo pipefail

daemon="${1:?usage: smoke-native-runtime.sh <daemon-root> <scratch-root>}"
scratch="${2:?usage: smoke-native-runtime.sh <daemon-root> <scratch-root>}"
pnpm_root="$daemon/node_modules/.pnpm"

resolve_package() {
  local result_name="$1"
  local pattern="$2"
  local module_path="$3"
  local -a entries=()
  local resolved

  mapfile -d '' entries < <(
    find "$pnpm_root" -mindepth 1 -maxdepth 1 -type d -name "$pattern" -print0
  )
  if [[ "${#entries[@]}" -ne 1 ]]; then
    printf 'expected one runtime package matching %s, found %s\n' \
      "$pattern" "${#entries[@]}" >&2
    exit 1
  fi
  resolved="${entries[0]}/node_modules/$module_path"
  [[ -e "$resolved" ]] || {
    printf 'runtime package payload is missing: %s\n' "$resolved" >&2
    exit 1
  }
  printf -v "$result_name" '%s' "$resolved"
}

resolve_package onnx 'onnxruntime-node@*' onnxruntime-node
resolve_package sharp_package 'sharp@*' sharp
resolve_package msgpackr 'msgpackr-extract@*' msgpackr-extract
resolve_package playwright 'playwright-core@*' playwright-core
resolve_package claude '@anthropic-ai+claude-agent-sdk-linux-x64@*' \
  '@anthropic-ai/claude-agent-sdk-linux-x64/claude'

bun -e '
  const ort = require(process.argv[1]);
  if (typeof ort.InferenceSession?.create !== "function")
    throw new Error("onnxruntime-node native binding did not load");
' "$onnx"

bun -e '
  const sharp = require(process.argv[1]);
  const png = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "#123456ff" },
  }).png().toBuffer();
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50)
    throw new Error("sharp native transform failed");
' "$sharp_package"

bun -e '
  const extract = require(process.argv[1]);
  if (typeof extract.extractStrings !== "function")
    throw new Error("msgpackr-extract native addon did not load");
' "$msgpackr"

bun -e '
  const playwright = require(process.argv[1]);
  if (typeof playwright.chromium?.launchPersistentContext !== "function")
    throw new Error("playwright-core chromium API did not load");
' "$playwright"

install -d -m700 "$scratch/home" "$scratch/state" "$scratch/config" "$scratch/cache"
version_output="$(
  env \
    ALL_PROXY=http://127.0.0.1:9 \
    HTTPS_PROXY=http://127.0.0.1:9 \
    HTTP_PROXY=http://127.0.0.1:9 \
    NO_PROXY= \
    HOME="$scratch/home" \
    XDG_STATE_HOME="$scratch/state" \
    XDG_CONFIG_HOME="$scratch/config" \
    XDG_CACHE_HOME="$scratch/cache" \
    timeout 20 "$claude" --version
)"
[[ "$version_output" =~ [0-9]+[.][0-9]+[.][0-9]+ ]] || {
  printf 'Claude SDK x64 executable returned an invalid version: %s\n' \
    "$version_output" >&2
  exit 1
}

printf 'Native runtime smoke test passed: %s\n' "$daemon"
