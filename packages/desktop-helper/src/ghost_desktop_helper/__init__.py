"""ghost-desktop-helper: the ghost's Omarchy computer-use Python sidecar.

A thin JSON stdin/stdout bridge over a vendored, attributed subset of
omarchy-quattro-harness (MIT, Fabio Pauli). See README.md and DESKTOP_HELPER.md.

The vendored harness lives in the sibling ``vendor/`` directory as the
top-level ``omaharness`` package. When the helper runs from a source checkout
(uv run, python -m, the tests) that directory is not automatically on the
import path, so bootstrap it here. When installed as a wheel, ``omaharness`` is
shipped alongside this package and importable directly; the bootstrap is then a
harmless no-op because the sibling path does not exist.
"""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

__version__ = "0.1.0"


def _bootstrap_vendor() -> None:
    try:
        import omaharness  # noqa: F401 - already importable (installed wheel)

        return
    except ImportError:
        pass
    # packages/desktop-helper/src/ghost_desktop_helper/__init__.py -> vendor/
    vendor = _Path(__file__).resolve().parent.parent.parent / "vendor"
    if vendor.is_dir() and str(vendor) not in _sys.path:
        _sys.path.insert(0, str(vendor))


_bootstrap_vendor()

__all__ = ["__version__"]
