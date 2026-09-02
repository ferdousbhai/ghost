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

Ghost no longer depends on Oh My Pi. Two pieces of Ghost's own code were ported
from it under the MIT license: the shape of the `ask` tool
(`packages/daemon/src/ask-tool.ts`) and the `mcp.json` configuration shape
(`packages/daemon/src/mcp-config.ts`), taken from Oh My Pi commit
`160ed439ac0df594347e7d7018b813a7ffdb5e81`.

Portions of `packages/daemon/src/advisor-*.ts`, `watchdog-files.ts`, and
`prompts/advisor-system.md` are adapted from oh-my-pi
([github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)),
© Stencil Labs, Inc., MIT.

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

## slop-detector

The daemon's anti-slop engine
(`packages/daemon/src/anti-slop.ts`) is a TypeScript port of the rule engine
from [slop-detector](https://github.com/ferdousbhai/slop-detector)
(`extension/engine.js`, commit
`6e2733726bae8e22d46fbe87a7f28e0e40969e5a`), which credits
dmmulroy/anti-slop (architecture), the cursor/plugins unslop skill, and
petergyang/no-ai-slop (pattern lists) as its pattern sources.

MIT License

Copyright (c) 2026 Ferdous Bhai

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
minimal, desktop-only vendor of
[omarchy-quattro-harness](https://github.com/fabiopauli/omarchy-quattro-harness)
by Fabio Pauli, pinned to upstream commit
[`5bc268d7558971fbbe4570f6c04cf62a67f93d42`](https://github.com/fabiopauli/omarchy-quattro-harness/tree/5bc268d7558971fbbe4570f6c04cf62a67f93d42).
After their six-line provenance headers, `atspi`, `capture`, `dispatch`,
`errors`, `headless`, `hypr`, `keys`, `session`, `toplevels`, and `transaction`
match that revision. Ghost modifies `__init__.py` to expose only the vendored
error types, `inputs.py` to cap repeated click injection at three clicks, and
`process.py` to bound combined captured child output. The browser, CLI,
controls, desktop-orchestrator, knowledge, overlay, native-plugin, pointer, and
XWayland modules are intentionally not vendored.
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
