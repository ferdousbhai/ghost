#!/usr/bin/env bash
# Prove a published release installs the way users get it: a clean Arch
# container runs the public one-liner (summonghost.com/install) and must end
# up with this version of `ghost` and `ghost-runtime`. publish.sh runs this
# after publishing and rolls the release back if it fails.
#
#   verify-published.sh <version>
#
# The container gets Omarchy's package repository for the Omarchy-only
# dependencies, an unprivileged user with sudo (what the installer expects),
# and stubs for the desktop-session commands (systemctl --user, the shell
# rescan) that have no meaning without a session.
set -euo pipefail

version="${1:?usage: verify-published.sh <version>}"
command -v docker >/dev/null || {
  printf 'docker is required to verify a published release\n' >&2
  exit 1
}

probe='
set -euo pipefail
pacman-key --init >/dev/null 2>&1 || true
pacman -Sy --noconfirm --needed curl gnupg sudo >/dev/null 2>&1
printf "\n[omarchy]\nSigLevel = Never\nServer = https://pkgs.omarchy.org/stable/\$arch\n" >> /etc/pacman.conf
pacman -Sy --noconfirm omarchy-keyring >/dev/null 2>&1
sed -i "s/^SigLevel = Never$/SigLevel = Required DatabaseOptional/" /etc/pacman.conf
useradd -m tester && echo "tester ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/tester
printf "#!/bin/bash\nexec sudo pacman -S --noconfirm --needed \"\$@\"\n" > /usr/local/bin/omarchy-pkg-add
for stub in systemctl omarchy-shell omarchy; do printf "#!/bin/bash\nexit 0\n" > /usr/local/bin/$stub; done
chmod +x /usr/local/bin/*
su tester -c "curl -fsSL https://summonghost.com/install | bash" >/dev/null 2>&1
pacman -Q ghost ghost-runtime
'

# GitHub's "latest" redirect can lag a new release by a little; try for a while.
for attempt in 1 2 3 4; do
  installed="$(docker run --rm archlinux:base-devel bash -c "$probe" 2>/dev/null || true)"
  if [[ "$installed" == "ghost $version-"*$'\n'"ghost-runtime $version-"* ]]; then
    printf 'Verified: the public one-liner installs\n%s\n' "$installed"
    exit 0
  fi
  printf 'attempt %s: got "%s", wanted ghost %s; retrying in 30s\n' "$attempt" "${installed:-nothing}" "$version" >&2
  sleep 30
done
printf 'the public one-liner does not install ghost %s\n' "$version" >&2
exit 1
