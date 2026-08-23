"""``python -m ghost_desktop_helper`` entry point."""

from __future__ import annotations

import sys

from .protocol import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
