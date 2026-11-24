#!/usr/bin/env bash
# Called only inside arch-run's disposable native root: runs the workspace's
# tests, then builds the stable recipe from this commit's source archive.
set -euo pipefail
[[ ${GHOST_ARCH_ROOT:-} == 1 && $EUID == 0 ]] || { echo 'Use packaging/arch/arch-run.sh.' >&2; exit 1; }
BUILD_ARCH=$(uname -m)
pacman -S --needed --noconfirm base-devel git
git config --global --add safe.directory /source
git config --global --add safe.directory /source/.git
git clone --no-hardlinks /source /build
commit=$(git -C /source rev-parse HEAD)
[[ $(git -C /build rev-parse HEAD) == "$commit" ]]
# Every depends/makedepends/checkdepends entry the recipe declares, and what
# the workspace's own tests call.
mapfile -t constraints < <(bash -c 'source /build/packaging/omarchy/pkgbuilds/ghost/PKGBUILD.in; printf "%s\n" "${depends[@]}" "${makedepends[@]}" "${checkdepends[@]}" nodejs ripgrep' | sort -u)
nodeps=()
if [[ $BUILD_ARCH == aarch64 ]]; then
  install -Dm755 /source/.ci/bun/bun /usr/local/bin/bun
  # pacman cannot see the upstream bun, so makepkg skips its
  # dependency check here and every other entry is checked below.
  nodeps=(--nodeps)
  kept=()
  for constraint in "${constraints[@]}"; do
    [[ ${constraint%%[<>=]*} == bun ]] || kept+=("$constraint")
  done
  constraints=("${kept[@]}")
fi
pacman -S --needed --noconfirm "${constraints[@]%%[<>=]*}"
pacman -T "${constraints[@]}"
bun --version
chown -R builder:builder /build /output /cache/pnpm
su builder -c "set -euo pipefail
cd /build
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
# The window's scripted QA needs a display; pnpm verify runs it.
GHOST_WINDOW_QA=0 pnpm test
version=\$(bash packaging/release/verify-release-version.sh .)
recipe=\$(mktemp -d)/ghost
bash packaging/release/make-source-archive.sh . \"\$recipe.tar.gz\" \"\$version\" HEAD
bash packaging/release/render-arch-package.sh \"\$recipe\" \"\$version\" \"\$(sha256sum \"\$recipe.tar.gz\" | cut -d' ' -f1)\"
mv \"\$recipe.tar.gz\" \"\$recipe/ghost-\$version.tar.gz\"
cd \"\$recipe\"
PKGDEST=/output PKGEXT=.pkg.tar.zst makepkg --force ${nodeps[*]}"
