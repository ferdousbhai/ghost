#!/usr/bin/env bash
# ferdousbhai.com/ghost/install.sh: installs the latest release from Omarchy's
# repository when it has it, else builds Omarchy's recipe for it, and always
# ends with the Install menu's own steps. Exercised with stub commands; nothing
# here touches pacman, the network, or the owner's session.
set -euo pipefail
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$(realpath -e -- "$script_dir/../..")"

installer=packaging/release/install.sh
bash -n "$installer"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/recipe/ghost"
printf 'pkgname=(ghost-runtime ghost)\n' > "$work/recipe/ghost/PKGBUILD"
tar -czf "$work/ghost-recipe.tar.gz" -C "$work/recipe" ghost

# curl serves the release API, the recipe, and the menu script by URL.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""; url=""
while (( $# )); do
  case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
case "$url" in
  */releases/latest) body='{"tag_name":"v0.10.0"}' ;;
  */download/v0.10.0/ghost-recipe.tar.gz) cp "$TEST_STATE/ghost-recipe.tar.gz" "$out"; exit 0 ;;
  */download/v0.10.0/omarchy-install-ai-ghost) printf 'echo menu >> "%s/actions"\n' "$TEST_STATE" > "$out"; exit 0 ;;
  *) exit 22 ;;
esac
if [[ -n $out ]]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
STUB
# pacman answers from the case's state: what is installed, what the repository has.
cat > "$work/bin/pacman" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -Q)
    shift
    for pkg in "$@"; do
      [[ $pkg == ghost && -n $TEST_INSTALLED ]] && { echo "ghost $TEST_INSTALLED"; exit 0; }
      [[ $pkg == ghost-dev && $TEST_DEV == yes ]] && { echo "ghost-dev 0.10.0.r1-1"; exit 0; }
    done
    exit 1 ;;
  -Si) [[ -n $TEST_REPO ]] || exit 1; printf 'Name            : ghost\nVersion         : %s\n' "$TEST_REPO" ;;
  -S) echo "pacman $*" >> "$TEST_STATE/actions" ;;
esac
STUB
printf '#!/usr/bin/env bash\n"$@"\n' > "$work/bin/sudo"
printf '#!/usr/bin/env bash\necho "makepkg $*" >> "$TEST_STATE/actions"\n' > "$work/bin/makepkg"
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/omarchy-pkg-add"
chmod +x "$work/bin/"*
for command in bash awk cat cp jq mktemp rm tar gzip vercmp; do
  ln -s "$(command -v "$command")" "$work/bin/$command"
done

run() {
  : > "$work/actions"
  result=0
  PATH="$work/bin" TEST_STATE="$work" TEST_INSTALLED="$1" TEST_REPO="$2" TEST_DEV="${3:-no}" \
    bash "$installer" > "$work/output" 2>&1 || result=$?
}

# Omarchy's repository has the latest: install from it, build nothing.
run "" "0.10.0-1"
[[ $result == 0 ]]
grep -Fxq 'pacman -S --needed --noconfirm ghost ghost-runtime' "$work/actions"
! grep -q '^makepkg' "$work/actions" || exit 1
grep -Fxq menu "$work/actions"

# The repository is behind: build Omarchy's recipe for the release.
run "0.8.1-1" "0.8.1-1"
[[ $result == 0 ]]
grep -Fxq 'makepkg --syncdeps --install --noconfirm --needed --nocheck' "$work/actions"
! grep -q '^pacman' "$work/actions" || exit 1
grep -Fxq menu "$work/actions"
grep -Fq 'building 0.10.0 from its release' "$work/output"

# Already the latest: install nothing, still finish the menu's steps.
run "0.10.0-1" "0.8.1-1"
[[ $result == 0 ]]
! grep -qE '^(pacman|makepkg)' "$work/actions" || exit 1
grep -Fxq menu "$work/actions"

# Checkout packages are the checkout's to update.
run "" "0.10.0-1" yes
[[ $result != 0 ]]
grep -Fq 'ghost-dev' "$work/output"
[[ ! -s "$work/actions" ]]

echo "install.sh test passed"
