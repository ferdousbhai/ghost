#!/usr/bin/env bash
# Called only inside arch-run's disposable native root: formats and lints the
# workspace, then builds the recipe from this commit's source archive. The
# recipe's check() runs the tests and the packaging checks, once.
set -euo pipefail
[[ ${GHOST_ARCH_ROOT:-} == 1 && $EUID == 0 ]] || { echo 'Use packaging/arch/arch-run.sh.' >&2; exit 1; }
pacman -S --needed --noconfirm base-devel git
git config --global --add safe.directory /source
git config --global --add safe.directory /source/.git
git clone --no-hardlinks /source /build
commit=$(git -C /source rev-parse HEAD)
[[ $(git -C /build rev-parse HEAD) == "$commit" ]]
# Every depends and makedepends entry the recipe declares.
mapfile -t constraints < <(bash -c 'source /build/packaging/omarchy/pkgbuilds/ghost/PKGBUILD.in; printf "%s\n" "${depends[@]}" "${makedepends[@]}"' | sort -u)
pacman -S --needed --noconfirm "${constraints[@]%%[<>=]*}"
pacman -T "${constraints[@]}"
cargo --version
chown -R builder:builder /build /output /cache/cargo
su builder -c "set -euo pipefail
export CARGO_HOME=/cache/cargo
cd /build
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
version=\$(bash packaging/release/verify-release-version.sh .)
recipe=\$(mktemp -d)/ghost
bash packaging/release/make-source-archive.sh . \"\$recipe.tar.gz\" \"\$version\" HEAD
bash packaging/release/render-arch-package.sh \"\$recipe\" \"\$version\" \"\$(sha256sum \"\$recipe.tar.gz\" | cut -d' ' -f1)\"
mv \"\$recipe.tar.gz\" \"\$recipe/ghost-\$version.tar.gz\"
cd \"\$recipe\"
PKGDEST=/output PKGEXT=.pkg.tar.zst makepkg --force"
