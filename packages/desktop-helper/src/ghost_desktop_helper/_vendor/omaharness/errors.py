# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/errors.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Errors raised by omaharness.

The Omarchy port deliberately drops the macOS exception names instead of
aliasing them: nothing here maps onto Apple's permission model, so a
``mac.*`` compatibility shim would only invite wrong assumptions.
"""

from __future__ import annotations


class OmaHarnessError(RuntimeError):
    """Base error for Omarchy discovery or control failures."""


class CapabilityError(OmaHarnessError):
    """A required compositor, tool, or accessibility capability is missing.

    Raised instead of guessing. Every instance should name the capability and,
    where one exists, the remediation command ``doctor`` would print.
    """


class AmbiguousTargetError(OmaHarnessError):
    """A window or application query matched more than one live target."""


class StateRestoreError(OmaHarnessError):
    """A disruptive transaction could not restore the state it changed.

    This is also raised when restoration is deliberately skipped because the
    user interacted with the session mid-transaction; the harness reports the
    race rather than yanking the pointer or workspace back.
    """
