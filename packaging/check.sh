#!/usr/bin/env bash
set -euo pipefail

# The packaging checks, as the recipe's check() and the gate run them: every
# packaging script parses, then the staged payload, the release version, the
# installer and Omarchy's recipe. They need no Git metadata and build nothing.
here="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

for script in "$here"/*.sh "$here"/*/*.sh "$here"/omarchy/bin/*; do
  bash -n "$script"
done

bash "$here/release/test-payload.sh"
bash "$here/release/test-release-version.sh"
bash "$here/release/test-install-script.sh"
bash "$here/omarchy/test-contribution.sh"

printf 'Packaging checks passed\n'
