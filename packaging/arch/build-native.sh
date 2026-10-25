#!/usr/bin/env bash
# Called only inside arch-run's disposable native root.
set -euo pipefail
[[ ${GHOST_ARCH_ROOT:-} == 1 && $EUID == 0 ]] || { echo 'Use packaging/arch/arch-run.sh.' >&2; exit 1; }
BUILD_ARCH=$(uname -m)
pacman -S --needed --noconfirm base-devel git
git config --global --add safe.directory /source
git config --global --add safe.directory /source/.git
git clone --no-hardlinks /source /build
commit=$(git -C /source rev-parse HEAD)
[[ $(git -C /build rev-parse HEAD) == "$commit" ]]
# Every depends/makedepends/checkdepends entry the PKGBUILD declares.
mapfile -t constraints < <(cd /build/packaging/arch && bash -c "source PKGBUILD; printf \"%s\n\" \"\${depends[@]}\" \"\${makedepends[@]}\" \"\${checkdepends[@]}\"" | sort -u)
nodeps=()
if [[ $BUILD_ARCH == aarch64 ]]; then
  install -Dm755 /source/.ci/bun/bun /usr/local/bin/bun
  ln -s bun /usr/local/bin/bunx
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
chown -R builder:builder /build /output /cache/pnpm /cache/bun
su builder -c "export npm_config_store_dir=/cache/pnpm BUN_INSTALL_CACHE_DIR=/cache/bun; cd /build/packaging/arch && GHOST_SOURCE_REPO=file:///build GHOST_SOURCE_REF=commit=$commit PKGDEST=/output PKGEXT=.pkg.tar.zst makepkg --force ${nodeps[*]}"
printf "%s\n" "$commit" > /output/source-commit.txt
