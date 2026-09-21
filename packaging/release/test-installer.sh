#!/usr/bin/env bash
# The installer is a released artifact: publish.sh attaches install.sh to every
# release, and ferdousbhai.com/ghost/install.sh redirects to the latest one. So
# the gate checks it the way it checks the package recipe.
#
# Its add_signed_repo function is shared verbatim with the icloud-notes
# installer; both repositories pin the block's hash so a change to one copy
# fails a test until the twin is updated too.
set -euo pipefail
cd -- "$(git rev-parse --show-toplevel)"

bash -n install.sh

actual="$(sed -n '/^# --- add_signed_repo (shared) ---$/,/^# --- end add_signed_repo ---$/p' install.sh \
  | sed '1d;$d' | sha256sum | cut -d' ' -f1)"
expected="$(cat packaging/release/add_signed_repo.sha256)"
if [[ "$actual" != "$expected" ]]; then
  printf 'FAIL add_signed_repo drifted from its pinned hash: update packaging/release/add_signed_repo.sha256 here and the twin in icloud-notes together\n' >&2
  exit 1
fi
printf 'ok add_signed_repo matches its pinned hash\n'

# The one-liner the docs, the release notes and this repository's own
# verification hand to users. A rename that misses one of them is a 404 for
# everyone who copies it.
one_liner='curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash'
for file in docs/getting-started.md packaging/release/publish.sh packaging/release/verify-published.sh; do
  grep -qF "$one_liner" "$file" || {
    printf 'FAIL %s does not carry the published one-liner: %s\n' "$file" "$one_liner" >&2
    exit 1
  }
done
printf 'ok the published one-liner is spelled the same everywhere\n'
