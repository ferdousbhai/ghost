"""ghost-desktop-helper: the ghost's Omarchy computer-use Python sidecar.

A thin JSON stdin/stdout bridge over a vendored, attributed subset of
omarchy-quattro-harness (MIT, Fabio Pauli). See README.md and
docs/desktop-helper.md at the repository root.

The vendored harness is private implementation detail under
``ghost_desktop_helper._vendor``. It is never added to ``sys.path`` and cannot
shadow, or be shadowed by, an independently installed top-level ``omaharness``.

The only import-path bootstrap is for PyGObject. See ``_bootstrap_system_gi``.
"""

from __future__ import annotations

import os as _os
import sys as _sys
from importlib import util as _util
from pathlib import Path as _Path

__version__ = "0.1.0"

#: Set to a non-empty value to skip the system-PyGObject path bootstrap (for a
#: virtualenv that deliberately compiled its own bindings).
SYSTEM_GI_OPT_OUT = "GHOST_DESKTOP_NO_SYSTEM_GI"

#: Where a distribution drops PyGObject, mirroring omaharness.atspi's search.
_SYSTEM_LIB_DIRS = ("/usr/lib", "/usr/lib64", "/usr/local/lib")


def _bootstrap_system_gi() -> None:
    """Make the distro's PyGObject importable from an isolated environment.

    AT-SPI is the helper's only hard Python dependency, and it rides the
    system ``python-gobject`` build: PyGObject publishes **no wheels** (sdist
    only), so a distro compiles it once, against one minor version, into
    ``/usr/lib/pythonX.Y/site-packages``. A virtualenv created without
    ``--system-site-packages`` -- which is exactly what a plain ``uv run`` or
    ``uv tool install`` produces, neither of which can be told otherwise from
    project config -- cannot see it. Every ``ax_*`` op then refuses on a
    machine that is fully capable, and the semantic path stays dark for the
    least interesting reason imaginable.

    So: when ``gi`` is missing from an isolated environment, append the system
    ``site-packages`` for *this* interpreter's minor version. Two properties
    make that safe rather than clever. It **appends**, so nothing the
    environment installed can be shadowed by a distro package. And it is
    version-guarded, because a compiled extension belongs to exactly one minor
    version -- a mismatched directory is skipped rather than added to fail
    obscurely later. When the environment already has ``gi`` (system-site
    venv, system interpreter, self-compiled bindings) this is a no-op.
    """
    if _os.environ.get(SYSTEM_GI_OPT_OUT):
        return
    if _sys.prefix == _sys.base_prefix:
        return  # not isolated: the interpreter owns its own site-packages
    try:
        if _util.find_spec("gi") is not None:
            return
    except (ImportError, ValueError):  # pragma: no cover - hostile sys.path
        pass
    tag = f"python{_sys.version_info[0]}.{_sys.version_info[1]}"
    for root in _SYSTEM_LIB_DIRS:
        candidate = _Path(root) / tag / "site-packages"
        if (candidate / "gi").is_dir() and str(candidate) not in _sys.path:
            _sys.path.append(str(candidate))
            return


_bootstrap_system_gi()

__all__ = ["__version__", "SYSTEM_GI_OPT_OUT"]
