# The v3 runtime source's identity files, sourced by the builder, the
# verifier, and the verifier's regression so they share one format.

# The Bun minimum the daemon declares as `engines.bun` (">=x.y.z").
bun_runtime_min() {
  bun -e '
    const p = await Bun.file(process.argv[1]).json();
    const match = /^>=(\d+\.\d+\.\d+)$/.exec(p.engines?.bun ?? "");
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  ' "$1/packages/daemon/package.json"
}

# PAYLOAD.SHA256 of a runtime root: every file but the two identity files.
payload_hashes() (
  cd "$1"
  find . -type f ! -name MANIFEST ! -name PAYLOAD.SHA256 -printf '%P\0' \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
)

# MANIFEST of a runtime root whose BUNDLED-LICENSES and PAYLOAD.SHA256 are in
# place: <root> <version> <arch> <commit> <epoch> <bun-build> <bun-runtime-min>
runtime_manifest() {
  cat <<EOF
format=ghost-runtime-source/v3
version=$2
os=linux
arch=$3
source_commit=$4
source_date_epoch=$5
bun_build_version=$6
bun_runtime_min=$7
bundle_target=bun
bundled_license_manifest_sha256=$(sha256sum "$1/BUNDLED-LICENSES" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$1/PAYLOAD.SHA256" | cut -d' ' -f1)
EOF
}
