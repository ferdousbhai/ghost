#!/usr/bin/env bash
# ferdousbhai.com/ghost/install.sh — the terminal spelling of Omarchy → Install → AI → Ghost.
#
# Ghost is an Omarchy application and installs only through Omarchy's own
# package path: the `ghost` package, then the `ghostd` user service for this
# login. Until Omarchy's repository carries the package, every Ghost release
# doubles as a signed pacman repository; this script trusts its key (checked
# against the fingerprint pinned below), adds the repository, keeps it across
# `omarchy refresh pacman`, and installs from it, so `omarchy update` keeps
# Ghost current. Nothing is cloned or built in your home.
set -Eeuo pipefail

die() {
  printf '\nerror: %s\n' "$1" >&2
  exit 1
}

# --- add_signed_repo (shared) ---
# Trust a project's package-signing key (checked against the pinned
# fingerprint), add its signed pacman repository, and keep the repository
# across `omarchy refresh pacman`, which rewrites /etc/pacman.conf from
# Omarchy's defaults and then runs the user's pre-refresh-pacman hooks.
# Works as root (`sudo bash`) or as a desktop user (sudo inside). This text
# is identical in every installer that uses it, and each repository's test
# pins its hash: change it here and in its twins together.
add_signed_repo() {
  local name="$1" release="$2" fingerprint="$3"
  local conf="/etc/pacman.d/$name.conf" include="Include = /etc/pacman.d/$name.conf"
  local sudo='' key user home hook_dir
  (( EUID == 0 )) || sudo=sudo
  key="$(mktemp)"
  if ! curl -fsSL "$release/$name-signing-key.asc" -o "$key"; then
    rm -f "$key"
    echo "Could not download the package-signing key from $release." >&2
    return 1
  fi
  if ! gpg --batch --with-colons --show-keys "$key" 2>/dev/null | grep -q "^fpr:*:$fingerprint:"; then
    rm -f "$key"
    echo "The downloaded key does not match the pinned fingerprint $fingerprint; nothing was changed." >&2
    return 1
  fi
  $sudo pacman-key --add "$key"
  $sudo pacman-key --lsign-key "$fingerprint"
  rm -f "$key"
  printf '[%s]\nSigLevel = Required DatabaseRequired\nServer = %s\n' "$name" "$release" | $sudo tee "$conf" >/dev/null
  grep -qxF "$include" /etc/pacman.conf || printf '\n%s\n' "$include" | $sudo tee -a /etc/pacman.conf >/dev/null
  user="${SUDO_USER:-${USER:-$(id -un)}}"
  home="$(getent passwd "$user" | cut -d: -f6)"
  if [[ -n $home && -d $home/.config/omarchy ]]; then
    hook_dir="$home/.config/omarchy/hooks/pre-refresh-pacman.d"
    install -d -o "$user" -g "$(id -gn "$user")" "$hook_dir"
    printf '%s\n' '#!/bin/bash' \
      "# Restore the [$name] repository after Omarchy rewrote /etc/pacman.conf." \
      "grep -qxF '$include' /etc/pacman.conf || printf '\\n%s\\n' '$include' | sudo tee -a /etc/pacman.conf >/dev/null" \
      > "$hook_dir/$name"
    chown "$user" "$hook_dir/$name"
    chmod 755 "$hook_dir/$name"
  fi
  $sudo pacman -Sy
}
# --- end add_signed_repo ---

[[ "${EUID}" -ne 0 ]] || die "Run this as your desktop user, not root. It asks for sudo where the package system needs it."
command -v omarchy-pkg-add >/dev/null 2>&1 \
  || die "Ghost runs on Omarchy (https://omarchy.org). On Omarchy, open the menu and choose Install → AI → Ghost."

# Once Omarchy ships its own entry, that script is the whole install.
if command -v omarchy-install-ai-ghost >/dev/null 2>&1; then
  exec omarchy-install-ai-ghost
fi

if ! pacman -Si ghost >/dev/null 2>&1; then
  printf 'Adding the [ghost] package repository (asks for sudo).\n'
  add_signed_repo ghost https://github.com/ferdousbhai/ghost/releases/latest/download \
    35C47A06567940B6796B4D0F9B3C7BDF85268B31 || die "Could not add the [ghost] repository."
fi
omarchy-pkg-add ghost

# The daemon is a user unit. The HUD is an omarchy-shell plugin, so it is
# linked into this user's plugins directory and enabled in the shell that is
# already running — it needs no unit of its own.
systemctl --user daemon-reload
systemctl --user enable --now ghostd.service

mkdir -p ~/.config/omarchy/plugins
# -T, because plain `ln -sfn` onto an existing directory puts the link INSIDE
# it (…/ferdousbhai.ghost/plugin) and reports success, leaving a plugin the
# shell cannot load. Replacing a stale symlink or a fresh path both work; a
# real directory left by an older install is refused loudly instead.
plugin_link=~/.config/omarchy/plugins/ferdousbhai.ghost
if ! ln -sfnT /usr/share/ghost/plugin "$plugin_link" 2>/dev/null; then
  die "$plugin_link is a real directory, probably from an older install.
Move it aside and run this again:  mv $plugin_link{,.bak}"
fi
omarchy-shell shell rescanPlugins
omarchy plugin enable ferdousbhai.ghost

printf '\nGhost is installed, and in your app launcher.\n'
# Packaging edits no configuration of yours, so the summon key is still yours
# to bind: /usr/share/doc/ghost/shell-contrib/hyprland/ has ghost.lua for an
# Omarchy 4 Lua config and ghost.conf for a .conf one.
printf 'To summon it with Super + Ctrl + G, copy the sample your Hyprland config\n'
printf 'uses from /usr/share/doc/ghost/shell-contrib/hyprland/.\n'
# `ghost login` refuses before a ghost exists (login-command.ts), so the order
# matters and the last thing the installer prints should be the first thing
# that works.
printf '\nThen make a ghost and sign in:  ghost new <name> && ghost login <provider>\n'
