# Vendored: `@oh-my-pi/pi-catalog`

| | |
|---|---|
| **Upstream package** | [`@oh-my-pi/pi-catalog`](https://www.npmjs.com/package/@oh-my-pi/pi-catalog) |
| **Version** | `18.0.3` (pinned; name and version are kept byte-identical to upstream) |
| **Upstream source** | <https://github.com/can1357/oh-my-pi>, `packages/catalog` |
| **Upstream license** | MIT — see [`LICENSE`](./LICENSE) and [`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt), both preserved verbatim |
| **Vendored on** | 2026-08-24 |
| **Tracking issue** | [#3 — Sovereignty: vendor and strip OMP/pi into a self-contained ghost](https://github.com/ferdousbhai/ghost/issues/3), phase 1 |

Ghost is Apache-2.0; MIT composes into it cleanly. The upstream notices above are
not to be removed.

## Why this is vendored

Issue #3 makes ghost a sovereign project: self-contained, reproducible, and small
enough to hold in one head. `pi-catalog` is the first fork target because it is the
most strippable layer with the biggest byte win — nearly all of its ~335k lines are
the bundled `models.json`, which ships every provider omp has ever spoken to.

Vendoring buys supply-chain sovereignty and reproducible builds, and takes on
security patching in exchange. Note the deliberate scope: **`pi-ai` stays an external
dependency permanently** (per-provider serialization, streaming, and OAuth flows churn
upstream), and so does the Claude Code SDK. This directory is not the start of forking
those.

## What was changed

Everything under `src/` is upstream's, unmodified, except `src/models.json`. Two
deviations in total:

1. **`src/models.json` was tree-shaken to a provider allowlist.**

   | | providers | models | bytes |
   |---|---|---|---|
   | upstream | 64 | 4418 | 9,631,051 (9.18 MiB) |
   | vendored | 12 | 859 | 1,825,299 (1.74 MiB) |
   | **saved** | **−52** | **−3559** | **−7,805,752 (−81.0%)** |

   The rewrite is purely subtractive at the top level. `JSON.stringify(…, null, "\t")`
   round-trips upstream's formatting byte-for-byte (verified), so every surviving model
   row is identical to upstream and `src/models.json.d.ts` — a per-provider record keyed
   by model id, each row carrying an `api` field — stays accurate.

   The allowlist and the justification for each entry live in
   [`shake.config.json`](./shake.config.json).

2. **`scripts` was removed from `package.json`.** Upstream's `check`, `lint`, `test`,
   `fmt`, `gen:models` and `gen:proto` all reference inputs that are *not* in the
   published tarball (no `tsconfig.json`, no biome config, no `scripts/` directory), so
   they cannot run here — and `pnpm -r test` would fail on `bun test` finding zero test
   files. Nothing else about the manifest changed: the package name, version,
   dependencies, `main`, `types`, and the complete `exports` map (`.`, `./models.json`,
   `./build`, `./provider-models`, `./discovery`, `./identity`, `./wire/*`, `./compat/*`,
   the `./*` catch-all, `./*.js`) are untouched, and `dist/types` is retained so the
   `types` conditions still resolve.

   Upstream's `scripts/generate-models.ts` regenerator is *not* shipped on npm, so it
   could not be preserved. Re-syncing uses the published tarball instead — see below.

### Local inference is not affected by the shake

`ollama`, `llama.cpp`, `lm-studio`, `vllm` and `litellm` are **never bundled in
`models.json`**; they are discovered at runtime against a local endpoint by
`src/provider-models/openai-compat.ts` and `src/provider-models/cache-provider-id.ts`,
which are untouched TypeScript. Shaking `models.json` cannot take local models away.
They are named in the allowlist anyway to record the intent, and the shake script
reports them as `allowlisted but not bundled`.

## How it is wired in

- `pnpm-workspace.yaml` lists `vendor/pi-catalog` as a workspace package and declares
  `overrides: { "@oh-my-pi/pi-catalog": "workspace:*" }`, so **every** consumer resolves
  the in-tree copy — `pi-coding-agent`, `pi-ai`, `pi-agent-core`, and anything else
  transitively depending on it.
- The override lives in `pnpm-workspace.yaml`, not in the root `package.json`. pnpm 10
  no longer reads `pnpm.overrides` from `package.json` and warns if you put it there.
- `biome.json` excludes `vendor` — upstream code is not linted against ghost's rules.
- Ghost's own packages never import `@oh-my-pi/pi-catalog` directly; they reach it only
  through the OMP harness.

Verify resolution at any time:

```bash
cd packages/daemon
bun -e 'console.log(Bun.resolveSync("@oh-my-pi/pi-catalog/models.json",
  require("node:fs").realpathSync("node_modules/@oh-my-pi/pi-coding-agent")))'
# -> <repo>/vendor/pi-catalog/src/models.json
```

## Re-shaking after an allowlist change

Edit the `providers` array in [`shake.config.json`](./shake.config.json) (and add a
line to `rationale` saying why), then:

```bash
node scripts/shake-catalog.mjs --resync   # restore from upstream, then shake
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

`--resync` is required when you are *adding* a provider back, because the shake is
destructive: a provider already dropped from `src/models.json` cannot be recovered from
the shaken file. It reads the upstream tarball out of the pnpm store, so it needs that
tarball present — temporarily drop the override from `pnpm-workspace.yaml` and
`pnpm install` if the store no longer has it. The script says so if it cannot find it.

Other modes:

```bash
node scripts/shake-catalog.mjs           # shake in place (only removes)
node scripts/shake-catalog.mjs --check   # report only; exit 1 if a shake is due
```

The script is idempotent and validates its output against the `models.json.d.ts` shape
before writing.

If a ghost test starts depending on a provider that was shaken out, **add the provider
to the allowlist and re-sync** — do not edit the test.

## Re-syncing from a new upstream version

1. Bump the dependency so pnpm fetches the new tarball into the store. Temporarily
   remove the `@oh-my-pi/pi-catalog` override from `pnpm-workspace.yaml`, set the
   version wherever the OMP packages are pinned, and `pnpm install`.
2. Replace this directory's contents from
   `node_modules/.pnpm/@oh-my-pi+pi-catalog@<version>/node_modules/@oh-my-pi/pi-catalog/`,
   keeping `GHOST-VENDOR.md` and `shake.config.json`.
3. Re-apply the two deviations: delete `scripts` from `package.json`, then run
   `node scripts/shake-catalog.mjs`.
4. Restore the override, `pnpm install`, and re-verify the whole workspace.
5. Read upstream's `CHANGELOG.md` (retained here for exactly this purpose) for changes
   to the OMP harness invariants in [`CONTRACTS.md`](../../CONTRACTS.md) — an upstream
   release breaking those invariants is one of issue #3's two triggers.
6. Update the version, date, and the shake table in this file.
