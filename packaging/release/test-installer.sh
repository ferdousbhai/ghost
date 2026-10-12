#!/usr/bin/env bash
# The installer is a released artifact: publish.sh attaches install.sh to every
# release, and ferdousbhai.com/ghost/install.sh redirects to the latest one. So
# the gate checks it the way it checks the package recipe.
set -euo pipefail
# Relative to this file, not to git: test-check-dependencies.sh also runs this
# inside makepkg's check() and inside the extracted source archive, where
# there is no repository.
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$(realpath -e -- "$script_dir/../..")"

bash -n install.sh

# The one-liner the docs and the release notes hand to users. A rename that
# misses one of them is a 404 for everyone who copies it.
one_liner='curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash'
for file in docs/getting-started.md packaging/release/publish.sh; do
  grep -qF "$one_liner" "$file" || {
    printf 'FAIL %s does not carry the published one-liner: %s\n' "$file" "$one_liner" >&2
    exit 1
  }
done
printf 'ok the published one-liner is spelled the same everywhere\n'
