#!/usr/bin/env bash
# Install Ghost's latest release on Omarchy, or update to it:
#
#   curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash
#
# Omarchy's package repository is Ghost's install path; this is the same
# install, ahead of it. When the repository already has the latest release,
# it installs from there. Otherwise it builds Omarchy's own recipe for that
# release (pkgbuilds/ghost, attached to the release as ghost-recipe.tar.gz)
# with makepkg: the same `ghost` package, so
# `omarchy update` takes over from there once the repository catches up.
# Then it runs the Install menu's own steps (omarchy-install-ai-ghost, from
# the same release): start ghostd for this login.
#
# Run it as yourself; it asks for your password where pacman needs it.
set -euo pipefail

repository=ferdousbhai/ghost

die() {
  printf 'ghost install: %s\n' "$*" >&2
  exit 1
}

(( EUID != 0 )) || die "run this as yourself, not root: makepkg refuses root, and sudo is asked for where needed."
command -v omarchy-pkg-add >/dev/null || die "Ghost is an Omarchy app, and this machine is not running Omarchy."
for tool in curl jq makepkg vercmp; do
  command -v "$tool" >/dev/null || die "$tool is missing."
done

tag="$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest" | jq -r '.tag_name // empty')"
[[ $tag == v* ]] || die "could not find Ghost's latest release."
version="${tag#v}"
assets="https://github.com/$repository/releases/download/$tag"

installed="$(pacman -Q ghost 2>/dev/null | awk '{print $2}' || true)"
available="$(pacman -Si ghost 2>/dev/null | awk '/^Version/{print $3; exit}' || true)"

if [[ -n $installed ]] && (( $(vercmp "${installed%-*}" "$version") >= 0 )); then
  echo "Ghost $installed is already the latest release."
elif [[ -n $available ]] && (( $(vercmp "${available%-*}" "$version") >= 0 )); then
  echo "Installing Ghost $available from Omarchy's package repository..."
  sudo pacman -S --needed --noconfirm ghost
else
  echo "Omarchy's package repository has ${available:-no} Ghost; building $version from its release..."
  work="$(mktemp -d)"
  trap 'rm -rf -- "$work"' EXIT
  curl -fsSL -o "$work/recipe.tar.gz" "$assets/ghost-recipe.tar.gz"
  tar -xzf "$work/recipe.tar.gz" -C "$work"
  # The recipe checks the release archive against its published SHA-256.
  # --nocheck: the release ran these checks when it was published.
  # A cargo that is not pacman's (rustup's, say) builds it as well, and
  # pacman's Rust is not installed beside it.
  [[ ! -x $HOME/.cargo/bin/cargo ]] || PATH="$HOME/.cargo/bin:$PATH"
  cargo="$(command -v cargo || true)"
  if [[ -n $cargo ]] && ! pacman -Qo "$cargo" >/dev/null 2>&1; then
    echo "Building with $cargo."
    mapfile -t needed < <(cd -- "$work/ghost" && makepkg --printsrcinfo \
      | awk '$1 ~ /^(make)?depends$/ && $3 != "cargo" { print $3 }')
    (( ${#needed[@]} )) || die "could not read what Ghost needs from its recipe."
    # Only what is missing, so nothing already installed changes its reason.
    mapfile -t missing < <(pacman -T "${needed[@]}" || true)
    (( ! ${#missing[@]} )) || sudo pacman -S --asdeps --noconfirm "${missing[@]}"
    (cd -- "$work/ghost" && makepkg --nodeps --install --noconfirm --needed --nocheck)
  else
    # --rmdeps: what was installed only to build it goes again afterwards.
    (cd -- "$work/ghost" && makepkg --syncdeps --rmdeps --install --noconfirm --needed --nocheck)
  fi
fi

menu="$(mktemp)"
curl -fsSL -o "$menu" "$assets/omarchy-install-ai-ghost"
bash "$menu"
rm -f -- "$menu"
