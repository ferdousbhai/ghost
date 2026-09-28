#!/usr/bin/env bash
# Prove a published release installs the way users get it: a clean Arch
# container runs the public one-liner (ferdousbhai.com/ghost/install.sh, which
# redirects to this release's own install.sh asset) and must end
# up with this version of `ghost` and `ghost-runtime`. Given the previous
# version, it also proves the way installed users get it: that release
# installed from its own tag, then the `pacman -Syu` `omarchy update` runs,
# must land on this version. publish.sh runs this after publishing and rolls
# the release back if either fails.
#
#   verify-published.sh <version> [<previous-version>]
#
# The container gets Omarchy's package repository for the Omarchy-only
# dependencies, an unprivileged user with sudo (what the installer expects),
# and stubs for the desktop-session commands (systemctl --user, the shell
# rescan) that have no meaning without a session.
set -euo pipefail

version="${1:?usage: verify-published.sh <version> [<previous-version>]}"
previous="${2:-}"
script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v docker >/dev/null || {
  printf 'docker is required to verify a published release\n' >&2
  exit 1
}

omarchy_repo='
set -euo pipefail
pacman-key --init >/dev/null 2>&1 || true
pacman -Sy --noconfirm --needed curl gnupg sudo >/dev/null 2>&1
printf "\n[omarchy]\nSigLevel = Never\nServer = https://pkgs.omarchy.org/stable/\$arch\n" >> /etc/pacman.conf
pacman -Sy --noconfirm omarchy-keyring >/dev/null 2>&1
sed -i "s/^SigLevel = Never$/SigLevel = Required DatabaseOptional/" /etc/pacman.conf
'
probe="$omarchy_repo"'
useradd -m tester && echo "tester ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/tester
printf "#!/bin/bash\nexec sudo pacman -S --noconfirm --needed \"\$@\"\n" > /usr/local/bin/omarchy-pkg-add
for stub in systemctl omarchy-shell omarchy; do printf "#!/bin/bash\nexit 0\n" > /usr/local/bin/$stub; done
chmod +x /usr/local/bin/*
su tester -c "curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash" >/dev/null 2>&1
pacman -Q ghost ghost-runtime
'

# GitHub's latest/download/* alias does not serve a new release's assets the
# moment it is published, and 0.4.2 was rolled back over exactly that: the
# probe saw nothing for four attempts, and afterwards the alias answered 504
# for ghost.db for several more minutes while the explicit tag URL served it
# fine. Four attempts thirty seconds apart was not the settling time; this is.
log="$(mktemp)"
trap 'rm -f -- "$log"' EXIT

# `omarchy update` is `pacman -Syu` over the configured repositories. The
# previous release goes in through the installer's own add_signed_repo, pinned
# to that release's tag, then the repository points at latest as install.sh
# leaves it. The latest alias already served the fresh install above.
verify_upgrade() {
  local add_repo upgrade upgraded
  add_repo="$(sed -n '/^# --- add_signed_repo (shared) ---$/,/^# --- end add_signed_repo ---$/p' "$script_root/../../install.sh")"
  upgrade="$omarchy_repo$add_repo"'
add_signed_repo ghost https://github.com/ferdousbhai/ghost/releases/download/v'"$previous"' \
  35C47A06567940B6796B4D0F9B3C7BDF85268B31 >/dev/null 2>&1
pacman -S --noconfirm ghost >/dev/null 2>&1
pacman -Q ghost | grep -q "^ghost '"$previous"'-"
sed -i "s#^Server = .*#Server = https://github.com/ferdousbhai/ghost/releases/latest/download#" /etc/pacman.d/ghost.conf
LC_ALL=C pacman -Syu --noconfirm --overwrite "/usr/share/omarchy/*" >/dev/null 2>&1
pacman -Q ghost ghost-runtime
'
  upgraded="$(docker run --rm archlinux:base-devel bash -c "$upgrade" 2>"$log" || true)"
  if [[ "$upgraded" != "ghost $version-"*$'\n'"ghost-runtime $version-"* ]]; then
    printf 'an installed ghost %s does not upgrade to %s (got "%s"). The upgrade said:\n' "$previous" "$version" "${upgraded:-nothing}" >&2
    tail -n 20 -- "$log" >&2
    exit 1
  fi
  printf 'Verified: omarchy update takes an installed %s to\n%s\n' "$previous" "$upgraded"
}
for attempt in 1 2 3 4 5 6 7 8; do
  installed="$(docker run --rm archlinux:base-devel bash -c "$probe" 2>"$log" || true)"
  if [[ "$installed" == "ghost $version-"*$'\n'"ghost-runtime $version-"* ]]; then
    printf 'Verified: the public one-liner installs\n%s\n' "$installed"
    [[ -z "$previous" ]] || verify_upgrade
    exit 0
  fi
  printf 'attempt %s: got "%s", wanted ghost %s; retrying in 45s\n' "$attempt" "${installed:-nothing}" "$version" >&2
  sleep 45
done
# The rollback this triggers is expensive and the reason was being discarded,
# so the last attempt's own words go to the operator rather than /dev/null.
printf 'the public one-liner does not install ghost %s. The last attempt said:\n' "$version" >&2
tail -n 20 -- "$log" >&2
exit 1
