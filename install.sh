#!/usr/bin/env bash
# ferdousbhai.com/ghost/install.sh — the terminal spelling of Omarchy → Install → AI → Ghost.
#
# Ghost is an Omarchy application and installs only through Omarchy's own
# package path: the `ghost` package from Omarchy's repository, then the
# `ghostd` user service for this login, so `omarchy update` keeps Ghost
# current. Nothing is cloned or built in your home.
set -Eeuo pipefail

die() {
  printf '\nerror: %s\n' "$1" >&2
  exit 1
}

[[ "${EUID}" -ne 0 ]] || die "Run this as your desktop user, not root. It asks for sudo where the package system needs it."
command -v omarchy-pkg-add >/dev/null 2>&1 \
  || die "Ghost runs on Omarchy (https://omarchy.org). On Omarchy, open the menu and choose Install → AI → Ghost."

# Once Omarchy ships its own entry, that script is the whole install.
if command -v omarchy-install-ai-ghost >/dev/null 2>&1; then
  exec omarchy-install-ai-ghost
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
# `ghost login` refuses before a ghost exists (cli/common.ts), so the order
# matters and the last thing the installer prints should be the first thing
# that works.
printf '\nThen make a ghost and sign in:  ghost new <name> && ghost login <provider>\n'
