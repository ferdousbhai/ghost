# Vendored subset of omarchy-quattro-harness
# (https://github.com/fabiopauli/omarchy-quattro-harness)
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See vendor/omaharness/LICENSE for the full text.
#
# This is a MINIMAL, DESKTOP-ONLY vendor of the harness for the Ghost project's
# ghost-desktop-helper. The upstream package's __init__ re-exports the browser,
# desktop-orchestrator, and knowledge surfaces; none of those are vendored here
# (Ghost has its own relay + Playwright, and its own thin JSON bridge), so this
# __init__ deliberately imports nothing but the shared error types. Every
# vendored leaf module (dispatch, hypr, session, transaction, capture, headless,
# toplevels, keys, inputs, atspi, process, errors) is imported directly by the
# bridge, e.g. `from omaharness import dispatch`.
"""Vendored desktop craft from omarchy-quattro-harness (MIT, Fabio Pauli)."""

from __future__ import annotations

from .errors import (
    AmbiguousTargetError,
    CapabilityError,
    OmaHarnessError,
    StateRestoreError,
)

__all__ = [
    "AmbiguousTargetError",
    "CapabilityError",
    "OmaHarnessError",
    "StateRestoreError",
]
