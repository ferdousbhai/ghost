# Third-party notices

## T3 Code

Portions of the Claude Code runtime and event adapter are adapted from T3 Code
commit `2c4158f87a1b6a586d0aa5e0338f122cb7887c4f`. The exact source files and
Ghost-specific changes are recorded in
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md).

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lucide

The shell mascot and Chromium extension icon assets use Lucide's `ghost` glyph.

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Oh My Pi

The model-catalog ranking and OMP 18 harness integration—including `ask`,
steering/follow-up, fallback chains, and session-tree branching—were
implemented against modern Oh My Pi commit
`160ed439ac0df594347e7d7018b813a7ffdb5e81` and the pinned 18.0.3 packages.

`@oh-my-pi/pi-catalog` 18.0.3 is additionally **vendored in-tree** at
[`vendor/pi-catalog`](vendor/pi-catalog), with its upstream `LICENSE` and
`THIRD-PARTY-NOTICES.txt` preserved verbatim. The only change to upstream sources
is a provider tree-shake of `src/models.json`; see
[`vendor/pi-catalog/GHOST-VENDOR.md`](vendor/pi-catalog/GHOST-VENDOR.md).

MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## omarchy-quattro-harness

`packages/desktop-helper/src/ghost_desktop_helper/_vendor/omaharness/` is a
minimal, unmodified,
desktop-only vendor of
[omarchy-quattro-harness](https://github.com/fabiopauli/omarchy-quattro-harness)
by Fabio Pauli. The vendored modules (`atspi`, `capture`, `dispatch`, `errors`,
`headless`, `hypr`, `inputs`, `keys`, `process`, `session`, `toplevels`,
`transaction`) carry a provenance header pointing back to their upstream path;
only that header was added. The browser, CLI, desktop-orchestrator, knowledge,
overlay, native-plugin, and XWayland modules are intentionally not vendored.
See `packages/desktop-helper/src/ghost_desktop_helper/_vendor/omaharness/LICENSE`
for the full text.

MIT License

Copyright (c) 2026 Fabio Pauli

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
