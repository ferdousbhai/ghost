#!/usr/bin/env bash
set -euo pipefail

# The path the recipe's check() calls, here and in the 0.13.0 archive alike,
# so one recipe in Omarchy's repository builds either release and a release
# never waits on a recipe change there. The checks themselves are check.sh.
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/../check.sh"
