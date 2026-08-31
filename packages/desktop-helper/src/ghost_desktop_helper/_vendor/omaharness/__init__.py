# Vendored from omarchy-quattro-harness at commit
# 5bc268d7558971fbbe4570f6c04cf62a67f93d42.
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE for the full text.
#
# This initializer is Ghost-modified. The upstream file re-exports browser,
# desktop-orchestrator, and knowledge surfaces that are not vendored here, so
# this private package exposes only the shared error types.
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
