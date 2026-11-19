#!/usr/bin/env bash
# cargo for the workspace scripts: rustup's own directory when no cargo is on PATH.
set -euo pipefail
command -v cargo >/dev/null || PATH="$HOME/.cargo/bin:$PATH"
exec cargo "$@"
