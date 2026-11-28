# Third-party notices

## Lucide

The app icon is Lucide's `ghost` glyph. Ghost's bar
(`ghost-bar`) holds the Lucide 1.35.0 icons that
[omui](https://github.com/ferdousbhai/omui) bundles, each stroke outlined as a
filled path and renamed `om-<name>-symbolic`.

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

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

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

## Strata

Ghost's bar themes GTK 4 through [omui](https://github.com/ferdousbhai/omui),
whose theme code, empty GTK theme resource, hidden title bar, and visual
conventions are adapted from [Strata](https://github.com/lgse/strata) under the
MIT license.

MIT License

Copyright (c) 2026 LGSE Ltd.

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

## Rust crates

Ghost's binaries are built from the Rust crates below, each under the licence
named. `Cargo.lock` holds the exact versions.

The daemon and the `ghost` command (`ghostd`, `ghost`):

- MIT or Apache-2.0: bitflags, equivalent, foreign-types,
  foreign-types-shared, hashbrown, httparse, indexmap, itoa, libc, serde_core,
  serde_json
- Apache-2.0: openssl, the binding to the system's OpenSSL (itself
  Apache-2.0, and not part of Ghost's package), which is the TLS of the client
  of a ghost on another machine
- MIT or Apache-2.0, the [RustCrypto](https://github.com/RustCrypto) crates
  that encrypt and sign push alerts: aead, aes, aes-gcm, base16ct,
  block-buffer, cipher, const-oid, cpufeatures, crypto-bigint, crypto-common,
  ctr, der, digest, ecdsa, elliptic-curve, ff, ghash, group, hkdf, hmac,
  inout, opaque-debug, p256, polyval, primeorder, rand_core, rfc6979, sec1,
  sha2, signature, typenum, universal-hash, zeroize; and cfg-if
- BSD-3-Clause: subtle
- MIT: generic-array, openssl-sys, zmij
- Unlicense or MIT: memchr
- Zlib: foldhash

The bar (`ghost-bar`) reaches the daemon with the daemon's own client, so it
is built from all of the above, and from:

- MIT and ISC: omui (its Lucide icons and Strata theme code are above)
- MIT, the [gtk-rs](https://gtk-rs.org) crates: cairo-rs, cairo-sys-rs,
  gdk-pixbuf, gdk-pixbuf-sys, gdk4, gdk4-sys, gio, gio-sys, glib, glib-sys,
  gobject-sys, graphene-rs, graphene-sys, gsk4, gsk4-sys, gtk4, gtk4-sys,
  pango, pango-sys
- MIT: gdk4-wayland, gdk4-wayland-sys, gtk4-layer-shell, gtk4-layer-shell-sys, memoffset, pulldown-cmark, slab
- MIT or Apache-2.0: field-offset, futures-channel, futures-core,
  futures-executor, futures-io, futures-task, futures-util, pin-project-lite,
  smallvec, unicase
