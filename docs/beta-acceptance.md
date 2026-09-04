# First-beta owner acceptance runbook

Executes the remaining gates in [issue #17](https://github.com/ferdousbhai/ghost/issues/17)
on the owner's machine and captures the evidence each gate needs. Work the
phases in order; every step is a command to run or an observation to record.

**Candidate SHA:** `________________________________________`

Record it before the first command. Every gate proves a *specific* head, and
evidence gathered against a different head does not close a gate. Freeze it
with:

```sh
cd ~/github.com/ferdousbhai/ghost
SHA="$(git rev-parse HEAD)"; echo "$SHA"
git status --porcelain   # must be empty
EV=~/ghost-beta-evidence/"$SHA"; mkdir -p "$EV"
```

> **This runbook mutates the live system.** It installs a pacman package as
> root, enables and restarts `ghostd.service` / `ghost-shell.service` in your
> own session, writes systemd user timers, and requires real provider
> credentials and real provider turns. It is not a sandbox exercise. Do not
> start it on a machine whose Ghost state you are not willing to restart.
>
> The **release HOLD stays in force.** Nothing here creates a tag, a release
> repository, a public candidate, or an Omarchy submission. Phases 1 and 7 stop
> at exactly that boundary.

Convention: each step names the command, then **Pass**, **Fail**, and
**Record** (the artifact that goes in `$EV/` and gets cited in #17).

---

## Phase 0 — Preconditions

### 0.1 Host

```sh
systemctl --version | head -1                      # systemd >= 254
systemctl --user is-active graphical-session.target
bun --version                                      # >= 1.3.14 runtime, >= 1.4.0 to build
secret-tool --version && busctl --user list | grep -c org.freedesktop.secrets
bash packaging/arch/ci-dependencies.sh --constraints
```

**Pass:** systemd ≥ 254, graphical session active, a Secret Service provider on
the user bus with its default collection unlocked, and every constraint printed
by `ci-dependencies.sh` satisfied on the host.
**Fail:** any missing constraint — install it before continuing; a locked or
absent keyring makes every provider gate fail for the wrong reason
(`docs/keyring.md`).
**Record:** `$EV/00-host.txt`.

### 0.2 Optional harnesses

Ghost packages none of these. Install and authenticate outside Ghost only the
ones you intend to accept:

```sh
claude --version && claude auth status --json   # >= 2.1.251, loggedIn:true
codex --version
pi --version
obsidian version                                # >= 1.12.7, Obsidian open
```

**Record:** `$EV/00-harnesses.txt`. A harness you skip must still show a
truthful *unavailable* row in Phase 4.3 — skipping is a tested state, not a gap.

### 0.3 Authorization you are giving yourself

Write down, in the #17 comment, that you authorize for this run: package
install/upgrade/removal as root, enabling the two user units, `ghostd`
restarts, systemd user timers under `~/.config/systemd/user`, and real provider
turns. Everything else in #17 — candidate freeze, version selection, remote
publication, Omarchy submission, lifting the hold — stays out of scope here.

### 0.4 Candidate worktree

Every build and scan from §1.3 on runs from a dedicated worktree at the
candidate SHA, never from the working checkout:

```sh
git worktree add ~/ghost-beta/src "$SHA"
SRC=~/ghost-beta/src
```

Why: `packaging/release/make-source-archive.sh:43` snapshots the tree with
`git ls-files -co --exclude-standard`, and `-o` means **untracked files enter
the source archive**, so a stray scratch file left in the working checkout would
ship inside the public source tarball; a fresh worktree at `$SHA` has none.

**Pass:** `git -C "$SRC" rev-parse HEAD` equals `$SHA` and
`git -C "$SRC" status --porcelain` is empty.
**Record:** `$EV/00-worktree.txt`.

---

## Phase 1 — Build and inspect the candidate, no install

### 1.1 Build `ghost-dev` at the exact candidate SHA

```sh
cd packaging/arch
GHOST_SOURCE_REPO="file://$(git -C ../.. rev-parse --show-toplevel)" \
GHOST_SOURCE_REF="commit=$SHA" \
  makepkg --cleanbuild --noconfirm 2>&1 | tee "$EV/01-makepkg.log"
```

This one invocation is the whole build gate. `check()` runs
`test-release-source.sh`, `test-check-dependencies.sh`, `test-check-runtime.sh`,
`pnpm test`, `typecheck`, `lint`, and the desktop-helper `pytest -m 'not live'`;
`package()` runs `install-payload.sh`, which ends by running
`packaging/arch/smoke.sh` over the staged payload.

**Pass:** exit 0, the log ends with `Ghost package smoke test passed`, and
exactly one `ghost-dev-*-1-x86_64.pkg.tar.zst` exists whose `pkgver` ends in
`.g$(git rev-parse --short=7 "$SHA")`.
**Fail:** any non-zero exit, or a `pkgver` whose commit suffix is not the
candidate — you built a different head.
**Record:** the log, `ls -l` of the package, and its `sha256sum`.

### 1.2 Inspect the payload without installing

```sh
cd ~/github.com/ferdousbhai/ghost
PKG=$(ls -1 "$PWD"/packaging/arch/ghost-dev-*-1-x86_64.pkg.tar.zst)
bsdtar -tvf "$PKG" | tee "$EV/01-payload.txt"
bsdtar -tf "$PKG" | grep -E 'ghosts/|\.config/ghost|\.local/state' || echo "owns no user state"
```

**Pass:** the payload owns only `usr/…` plus `etc/xdg/quickshell/ghost`;
`usr/lib/systemd/user/{ghostd,ghost-shell}.service`,
`usr/lib/ghost/runtime/{ghostd.js,ghost.js,photon_rs_bg.wasm}`,
`usr/share/ghost/{quickshell,chromium-extension}`,
`usr/lib/ghost/package-smoke/service-browser-smoke.sh`, and
`usr/share/doc/ghost/docs/{keyring,hooks,claude-code-runtime}.md` are present;
the grep prints `owns no user state`.
**Record:** `$EV/01-payload.txt`.

### 1.3 Runtime source, determinism, and SDK exclusion

```sh
cd "$SRC"
version=$(bash packaging/release/verify-release-version.sh .)
epoch=$(git show -s --format=%ct "$SHA")
bash packaging/release/prepare-pnpm-engine.sh .
pnpm fetch --frozen-lockfile
SOURCE_DATE_EPOCH="$epoch" bash packaging/release/build-runtime-source.sh \
  . packaging/release/out "$version" x86_64 "$SHA"
SOURCE_DATE_EPOCH="$epoch" bash packaging/release/make-source-archive.sh \
  . "packaging/release/out/ghost-$version.tar.gz" "$version" "$SHA"
bash packaging/release/smoke-runtime-source.sh \
  "packaging/release/out/ghost-runtime-$version-linux-x86_64.tar.zst" \
  . "$version" x86_64 "$SHA" "$epoch" 2>&1 | tee "$EV/01-runtime-smoke.log"
```

`smoke-runtime-source.sh` verifies archive ownership and modes, the v3 MANIFEST
(including the `claude_agent_sdk=external@0.3.170` line), `PAYLOAD.SHA256`
closure, bundled-license closure, the launcher/scratch-daemon smoke, the Claude
Agent SDK source-byte regression against `lib/ghostd.js` and `lib/ghost.js`, and
byte-identical repacking.

The `make-source-archive.sh` call takes `"$SHA"` rather than `--worktree`, so
the snapshot comes from `git archive` at the frozen commit; nothing untracked
can reach it. Both archives are inputs to §1.5.

**Pass:** `Runtime source smoke test passed`.
**Record:** the log, plus `sha256sum` of the runtime archive and of
`packaging/release/out/ghost-$version.tar.gz`.

### 1.4 Claude SDK boundary harness (offline)

```sh
cd "$SRC"
store=$(mktemp -d)
pnpm --dir packaging/release/fixtures/claude-agent-sdk \
  --ignore-workspace --store-dir "$store" fetch --frozen-lockfile
GHOST_CLAUDE_SDK_STORE_DIR="$store" \
  bash packaging/release/test-claude-sdk-boundary.sh 2>&1 | tee "$EV/01-sdk-boundary.log"
```

The `pnpm fetch` is load-bearing: the boundary test installs the fixture graph
offline behind dead proxies and can only resolve from a store seeded first.

**Pass:** `Claude Agent SDK external-boundary test passed`.
**Record:** the log.

### 1.5 Secret scan of the candidate and its artifacts

The scan needs no publication destination and no `GHOST_RELEASE_REPOSITORY`:
§1.1 produced the package and §1.3 produced the source snapshot and the runtime
archive, all destination-free. Only *rendering the stable package* and
*publishing* need a destination, and those stop at §1.6.

Ghost pins no scanner in the tree. Use `gitleaks` from the Arch `extra`
repository (8.30.1 at the time of writing):

```sh
sudo pacman -S --needed gitleaks
gitleaks version
```

Scan the candidate worktree's git history first. The public snapshot is a
*selection* from that history, so a credential that was committed and later
deleted is still worth finding:

```sh
gitleaks git "$SRC" -c "$SRC/.gitleaks.toml" --no-banner --redact -v \
  2>&1 | tee "$EV/01-secret-scan.txt"
```

Then scan each artifact **after extraction** — gitleaks does not descend into
archives by default, so pointing it at the `.tar.gz`, `.tar.zst`, or
`.pkg.tar.zst` file proves nothing:

```sh
scan=~/ghost-beta/scan; rm -rf "$scan"; mkdir -p "$scan"/source "$scan"/runtime "$scan"/pkg
bsdtar -xf "$SRC/packaging/release/out/ghost-$version.tar.gz" -C "$scan/source"
bsdtar -xf "$SRC/packaging/release/out/ghost-runtime-$version-linux-x86_64.tar.zst" \
  -C "$scan/runtime"
bsdtar -xf "$PKG" -C "$scan/pkg"

for target in source runtime pkg; do
  printf '\n=== %s ===\n' "$target"
  gitleaks dir "$scan/$target" -c "$SRC/.gitleaks.toml" --no-banner --redact -v
done 2>&1 | tee -a "$EV/01-secret-scan.txt"
```

`git` and `dir` are the gitleaks 8.x subcommand names; `detect` and
`detect --no-git` are the deprecated 8.18-and-earlier spellings, still accepted
but hidden. `gitleaks --help` names the subcommands on the installed build —
check it once before the first scan.

**Pass:** all four invocations exit 0 and report no leaks.
**Fail:** any non-zero exit — gitleaks exits 1 both for a finding and for a scan
error, and 126 for an unknown flag, so read the output rather than the code
alone. Triage every finding by hand against the file and line it names. Never
add a finding to `.gitleaks.toml` to make the run pass.
**Record:** `$EV/01-secret-scan.txt`, plus a triage note per finding.

`.gitleaks.toml` at the repo root extends the default ruleset, disables no rule,
and allowlists exactly one thing: the credential-shaped literals in five
redaction tests (`packages/daemon/test/pi-runtime.test.ts`,
`principal-task-tools.test.ts`, `tasks.test.ts`,
`packages/extensions/test/home.test.ts`, `memory-file.test.ts`). It is
conditioned on the file *and* the exact fixture string, so it is not a path
exemption for tests in general, and a finding in any other file — or a new
fixture in these — is a hand-triage item.

### 1.6 Candidate freeze and stable rendering — stops here

Rendering the stable `ghost` package and producing a public candidate require
`GHOST_RELEASE_REPOSITORY` and an approved destination
(`packaging/release/render-arch-package.sh` refuses without one), which the
release hold forbids. Record that Phase 1 verified the destination-independent
source, runtime, and secret scan only, and that the candidate freeze and version
selection remain owner actions outside this runbook.

**What a version bump actually touches.** Not the PKGBUILDs.
`packaging/arch/PKGBUILD` states in a comment that its committed `pkgver` is not
authoritative and is regenerated by `pkgver()` from `package.json` on every
build, so it — and `packaging/arch/.SRCINFO` with it — is expected to lag HEAD.
The stable PKGBUILD is not committed at all; it is rendered from
`packaging/omarchy/pkgbuilds/ghost/PKGBUILD.in` with `@@VERSION@@` substituted at
render time. The bump is the six manifests
`packaging/release/verify-release-version.sh` enumerates — `package.json` at the
root and in `packages/{daemon,extensions,shell,chromium-extension}`, plus
`packages/chromium-extension/extension/manifest.json` — which must all carry the
same version:

```sh
bash "$SRC/packaging/release/verify-release-version.sh" "$SRC"   # prints the version
bash "$SRC/packaging/release/test-release-version.sh"           # rejects drift and 0.0.0
```

The current `0.0.1` is a **valid** release version: the checker rejects only
non-semver strings, components above 65535, and the all-zero `0.0.0`. Picking a
different number for the first beta is a naming choice, not a blocker.

---

## Phase 2 — Clean-account Obsidian setup

Run every step as the *desktop owner account you will accept on*, never as root.

### 2.1 Register the official CLI

Open Obsidian → **Settings → General → Command line interface** and complete
the official Linux registration (https://obsidian.md/help/cli). With Obsidian
still open:

```sh
command -v obsidian && obsidian version
```

**Pass:** a version ≥ `1.12.7`.
**Fail:** command not found, or an error — some Arch repackagings of the app
omit the standalone CLI payload; installing the GUI alone does not satisfy this.
**Record:** `$EV/02-obsidian-version.txt` plus a screenshot of the settings pane.

### 2.2 Install the upstream skill

```sh
npx -y skills@latest add https://github.com/kepano/obsidian-skills \
  --global --yes --skill obsidian-cli
test -f ~/.agents/skills/obsidian-cli/SKILL.md && echo present
```

**Pass:** `present`.
**Record:** `$EV/02-skill.txt`.

### 2.3 Readiness harness

```sh
bash packaging/arch/accept-obsidian.sh 2>&1 | tee "$EV/02-accept-obsidian.log"
# or, for an explicitly named vault:
bash packaging/arch/accept-obsidian.sh --vault "Owner Notes"
```

**Pass:** `Obsidian <x.y.z> readiness passed; permanently deleted ghost-obsidian-acceptance-…`.
**Fail:** it refuses as root, refuses a missing `SKILL.md`, refuses an
unregistered CLI, refuses a version below 1.12.7 (parsed from output, not from
exit status), or refuses to overwrite a pre-existing acceptance note.

**What it covers:** CLI presence and version, and one end-to-end
create → read → search → tasks → permanent-delete cycle on a uniquely named
marker note it owns, with vault selection only through the CLI.
**What it does not cover:** the GUI registration itself; that a *session* admits
the skill through normal machine-skill discovery; two-ghost shared visibility
with per-ghost privacy; and the visible-failure behaviour when the skill,
command, registration, or running app is missing. Those are session-level
proofs, already checked on the source path in #17; re-observe them once in
Phase 3.6 on the installed build.

---

## Phase 3 — Install, user services, first run, provider

### 3.1 Install

```sh
sudo pacman -U "$PKG" 2>&1 | tee "$EV/03-install.log"
```

**Pass:** install succeeds and the `post_install` hook prints the Obsidian
readiness steps, the Chromium extension path, the enable command, the optional
integrations, and the keyring/ghost-home note.
**Record:** the log — the hook text is the evidence that packaging *reports*
owner-level Obsidian setup rather than performing it (#54 owns the supported
gate).

### 3.2 Enable the user services

```sh
systemctl --user enable --now ghostd.service ghost-shell.service
systemctl --user is-enabled ghostd.service ghost-shell.service
systemctl --user status ghostd.service ghost-shell.service --no-pager | tee "$EV/03-units.txt"
```

**Pass:** both `enabled` and `active (running)`, both bound to
`graphical-session.target`, `ghostd` running `/usr/bin/ghostd` and the shell
running `/usr/bin/qs -c ghost --no-duplicate`.
**Fail:** a unit wanted by `default.target` — re-run with `reenable` (§7.1).

### 3.3 HUD and tray first run

Open the HUD from the tray icon, or from the keybinding you installed out of
`/usr/share/doc/ghost/shell-contrib/`. Confirm the tray item appears, the HUD
opens, and it reports the daemon as reachable.

**Record:** `$EV/03-hud.png`, `$EV/03-tray.png`.

### 3.4 Client and daemon identity

```sh
ghost --version; ghostd --version; ghost status | tee "$EV/03-status.txt"
```

**Pass:** both versions equal the packaged `pkgver` base version; `ghost status`
reports `reachable yes`, `authenticated yes`, and the token file path.

### 3.5 Provider login and model selection

```sh
ghost model --providers            # provider ids, auth types, signed-in accounts
ghost model login <provider>       # or drive the same flow from the HUD
ghost model --list --q <substring> # available models for the ghost
ghost model <provider>/<id>
ghost model
```

`ghost model login` runs through the daemon started in 3.2. `ghostd login` is
the offline path and refuses to run while `ghostd.service` holds the ghosts-root
reservation, so use it only with the unit stopped.

**Pass:** login completes without Ghost prompting for a credential it stores
itself outside Secret Service; `ghost model` echoes the selection.
**Record:** `$EV/03-model.txt` and `secret-tool search --all service <provider>`
output showing the item under Ghost's own schema.

### 3.6 First turns, shared state, private memory

Run one Pi turn and — if Phase 5 is done — one Claude turn from the HUD, in two
different ghosts, and confirm through them that:

- the Obsidian skill is admitted once by ordinary machine-skill discovery
  (`GET /sessions/:id/resources` shows its source and readiness);
- a note or task one ghost creates is visible to the other;
- persona, conversations, and memory are not;
- with Obsidian closed, the operation fails visibly with no raw-file fallback.

**Record:** `$EV/03-shared-state.md` with the bounded transcript excerpts.

### 3.7 Browser relay

```sh
ghostd relay-token
```

Load `/usr/share/ghost/chromium-extension` unpacked in the Chromium you use,
paste the token in the popup, **Save & connect**.

**Pass:** the popup reports connected; **Pause** refuses requests without
unpairing.
**Record:** `$EV/03-relay.png`.

### 3.8 Packaged service/browser smoke

```sh
/usr/lib/ghost/package-smoke/service-browser-smoke.sh 2>&1 | tee "$EV/03-service-smoke.log"
```

**Pass:** both lines — `Ghost terminal client reached the packaged daemon.` and
`Browser relay endpoint is serving from the packaged daemon.`

### 3.9 Desktop helper

The helper is a stdio JSON protocol with no CLI of its own; exercise it through
the `ghost_desktop` tool in a session (`state`, `see`, then one `capture`) and
confirm the honesty metadata comes back.

**Record:** `$EV/03-helper.md`.

---

## Phase 4 — Installed native delegation

### 4.1 `ghost delegation` in all three modes, daemon-free

```sh
ghost delegation            | tee "$EV/04-delegation-human.txt"
ghost delegation --json     | tee "$EV/04-delegation.json"
ghost delegation -q         | tee "$EV/04-delegation-quiet.txt"
GHOSTD_PORT=9 ghost delegation --json   # must be byte-identical to the above
```

**Pass:** a three-row table (`pi`, `codex`, `claude-code`) with
`availability` ∈ {available, unavailable} and `authentication` ∈
{authenticated, logged_out, unknown}; `--json` emits exactly
`{"harnesses":[…]}` with only those three fields per row; `-q` emits
`N/3 available`; the `GHOSTD_PORT=9` run matches, proving the verb never opens
ghostd or ghost data.
**Fail:** any row asserting availability for a harness you did not install, any
network egress, or any mutation under `~/ghosts`.
**Record:** all three outputs plus the port-9 diff.

### 4.2 Trusted disposable project

```sh
mkdir -p ~/ghost-beta/demo && git -C ~/ghost-beta/demo init -q
```

Bind it as the trusted project from the HUD's project chip (`PUT
/sessions/:id/project`); an arbitrary cwd is never authority. Then, in a Pi
conversation and again in a Claude conversation, exercise the full lifecycle
through the principal task tools: `task` (create), `task_list`, `task_get`
(bounded events and result), `task_send` while it is still running, and
`task_cancel`.

Mirror each state for the record over the API:

```sh
TOKEN=$(ghostd api-token --quiet)
curl -s -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:7717/sessions/<sessionId>/tasks | tee "$EV/04-tasks.json"
curl -s -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:7717/sessions/<sessionId>/tasks/<taskId>
```

**Pass:** every terminal and reverse state is reachable and visible — created,
running, followed-up, cancelled, and the confirmed-quiescent terminal state that
cancellation only publishes after the captured scope is gone.
**Record:** `$EV/04-lifecycle-pi.md`, `$EV/04-lifecycle-claude.md`, the JSON.

### 4.3 Every advertised worker, plus truthful negative states

Start one task per worker (`pi`, `codex`, `claude-code`). Then, for a harness
you deliberately did not install or did not log into, confirm `ghost delegation`
and a `task` attempt both report unavailable / logged-out **without starting a
provider turn** (no token spend, no session in `ghost sessions`).

**Record:** `$EV/04-workers.md` with one line per worker and per negative state.

### 4.4 Delete a conversation with active work

```sh
ghost rm -s <sessionId> --yes; echo "exit=$?"     # while a task is running
```

**Pass:** refused with exit code `6` and error code `tasks_active`. After the
workers settle, re-run: the delete succeeds, `~/ghosts/<ghost>/.tasks/` no
longer holds the record, and the terminal delegated history moved with the
transcript into the private Trash transaction.
**Record:** both runs, plus a `find ~/ghosts/<ghost>/.tasks -type f` before and
after and the Trash destination reported by the delete.

### 4.5 Restart during receipt-owned work

```sh
systemctl --user list-units --all 'ghost-task-*.scope' | tee "$EV/04-scopes-before.txt"
systemctl --user list-units --all > "$EV/04-units-before.txt"     # start a task first
systemctl --user restart ghostd.service                            # owner-authorized
systemctl --user list-units --all 'ghost-task-*.scope' | tee "$EV/04-scopes-after.txt"
systemctl --user list-units --all > "$EV/04-units-after.txt"
diff "$EV/04-units-before.txt" "$EV/04-units-after.txt"
```

**Pass:** the exact `ghost-task-<UUID>.scope` units captured before the restart
are recovered and quiesced (inactive or absent), their task rows read
*interrupted* rather than resumed, and the diff shows no other user unit or
process touched.
**Fail:** a scope still active after the daemon publishes a terminal state, or
any unrelated unit in the diff.

### 4.6 `systemd >= 254` refusal

```sh
grep -n 'systemd' packaging/arch/.SRCINFO
pacman -Qi ghost-dev | grep -i depends
```

**Pass:** the direct dependency `systemd>=254` is declared and pacman records
it, so an unsupported system cannot install Ghost at all.
**Note:** proving the actual refusal needs a separate pre-254 image; see
*Not covered*.

---

## Phase 5 — Claude SDK boundary

The install root is
`${XDG_DATA_HOME:-$HOME/.local/share}/ghost/claude-agent-sdk/0.3.170`.

```sh
SDK="${XDG_DATA_HOME:-$HOME/.local/share}/ghost/claude-agent-sdk/0.3.170"
```

### 5.1 Fail closed with no SDK installed

```sh
ls "$SDK" 2>&1                       # must not exist yet
ghost delegation | tee "$EV/05-no-sdk.txt"
ghost model claude-code/default && ghost say --new "hello"; echo "exit=$?"
```

**Pass:** `claude-code` is `unavailable`; the Claude turn fails with
`Claude Agent SDK 0.3.170 is not installed at <root>` and the printed
`pnpm add --dir …` repair command; a Pi model in the same ghost still answers
normally.
**Record:** `$EV/05-no-sdk.txt` and the failing turn's stderr.

### 5.2 Install the exact documented graph

```sh
mkdir -p "$SDK"
pnpm add --dir "$SDK" --save-exact \
  @anthropic-ai/claude-agent-sdk@0.3.170 \
  @anthropic-ai/sdk@0.93.0 \
  @modelcontextprotocol/sdk@1.29.0 \
  zod@4.4.3
systemctl --user restart ghostd.service          # owner-authorized
ghost delegation | tee "$EV/05-sdk-installed.txt"
```

**Pass:** exactly those four packages at those versions; `claude-code` becomes
`available` with `authentication` reflecting `claude auth status --json`, which
Ghost runs against the owner's own installation.

### 5.3 Prove both Claude paths without Ghost collecting credentials

```sh
ghost model claude-code/default
ghost say --new "Summarize this repository's CONTRACTS.md in three lines."
```

Then start one delegated task with agent `claude-code` in the trusted project
from §4.2.

**Pass:** both paths run; Ghost never prompts for or stores a Claude credential
— confirm with `secret-tool search --all service claude` (no Ghost-schema item)
and by grepping `~/.config/ghost` for any Claude secret.
**Record:** `$EV/05-principal.md`, `$EV/05-delegated.md`, `$EV/05-no-creds.txt`.

### 5.4 Removal fails closed, with no stale reuse

```sh
mv "$SDK/node_modules" "$SDK/node_modules.away"
ghost say -s <claudeSessionId> "still there?"; echo "exit=$?"
```

**Pass:** the next Claude turn — principal or delegated, new session or a warm
reused one — errors with
`Claude Agent SDK 0.3.170 is restart-required: …`, and keeps failing until the
daemon restarts. Nothing runs on stale or mismatched code.

```sh
systemctl --user restart ghostd.service
ghost delegation | tee "$EV/05-sdk-removed.txt"     # claude-code unavailable again
mv "$SDK/node_modules.away" "$SDK/node_modules"     # restore
```

Repeat once with a *mismatched* graph (e.g. `pnpm add --dir "$SDK" --save-exact
zod@4.4.2`) and confirm the version-mismatch refusal rather than a load.
**Record:** both error texts verbatim.

### 5.5 Package-level exclusion

Cite §1.2 (no SDK paths in the payload) and §1.3 (the v3 manifest's
`claude_agent_sdk=external@0.3.170` plus the source-byte regression). Reviewed
pins, types, lockfile entries, loader code, and the offline install fixture are
deliberately retained; shared MCP, Zod, and Anthropic SDK dependencies that
Ghost/pi independently require are deliberately not excluded.

---

## Phase 6 — Scheduled work, disposable ghost

Unit names are the ownership contract:
`ghost-timer-v1-<byte-length-of-ghost-name>-<ghost>-<slug>.{service,timer}` in
`~/.config/systemd/user`. For a ghost named `betaops` (7 bytes) and slug
`beta-acceptance` that is
`ghost-timer-v1-7-betaops-beta-acceptance.timer`.

### 6.1 Create a near-future schedule

```sh
ghost new betaops
```

In a `betaops` conversation, ask it to schedule one run about three minutes
out with slug `beta-acceptance`. It writes both units itself through Bash — Ghost
has no scheduler.

```sh
U=~/.config/systemd/user/ghost-timer-v1-7-betaops-beta-acceptance
cat "$U.service" "$U.timer" | tee "$EV/06-units.txt"
systemd-analyze --user verify "$U.timer"
systemctl --user is-enabled ghost-timer-v1-7-betaops-beta-acceptance.timer
systemctl --user list-timers --all | grep ghost-timer-v1- | tee "$EV/06-timers.txt"
```

**Pass:** `systemd-analyze` is silent; the timer is `enabled` and listed with a
next elapse; the service is `Type=oneshot`, `TimeoutStartSec=infinity`, and
`ExecStart=/usr/bin/ghost say --new --ghost betaops "…"`.
**Fail:** a unit outside that directory, a slug outside
`[a-z0-9]+(?:-[a-z0-9]+)*`, or a name missing the versioned length-delimited
prefix.

### 6.2 Let it fire

```sh
journalctl --user -u ghost-timer-v1-7-betaops-beta-acceptance.service \
  --no-pager | tee "$EV/06-journal.txt"
ghost sessions -g betaops | tee "$EV/06-sessions.txt"
ghost show -g betaops -s <newSessionId> | tee "$EV/06-transcript.md"
```

**Pass:** exactly one service invocation, exit 0, and exactly one new completed
conversation with a real assistant reply.

### 6.3 Survive a daemon restart

```sh
systemctl --user restart ghostd.service         # owner-authorized
systemctl --user list-timers --all | grep ghost-timer-v1-
```

**Pass:** the timer is still scheduled and enabled after the restart, and the
journal plus `ghost sessions -g betaops` show it fired exactly once in total —
the restart neither re-fired nor dropped it.

### 6.4 Rename retires the exact old-name units only

First plant decoys that must survive untouched:

```sh
D=~/.config/systemd/user
: > "$D/ghost-timer-betaops-legacy.timer"                    # unversioned legacy form
: > "$D/ghost-timer-v1-8-betaopsx-neighbour.timer"           # prefix neighbour
sha256sum "$D"/ghost-timer-* > "$EV/06-decoys-before.txt"
```

Rename the ghost:

```sh
curl -s -X PUT -H "authorization: Bearer $(ghostd api-token --quiet)" \
  -H 'content-type: application/json' --data '{"name":"betaops2"}' \
  http://127.0.0.1:7717/api/ghosts/betaops/name
ls "$D" | grep ghost-timer- | tee "$EV/06-units-after-rename.txt"
sha256sum "$D"/ghost-timer-* > "$EV/06-decoys-after.txt"
diff "$EV/06-decoys-before.txt" "$EV/06-decoys-after.txt"   # decoy rows unchanged
systemctl --user list-timers --all | grep ghost-timer-v1- || echo "no owned timers"
```

**Pass:** every `ghost-timer-v1-7-betaops-*` unit and its `timers.target.wants`
link is gone, the two decoys are byte-identical, and no stray timer remains
loaded.

### 6.5 Delete retires the same way

Create one more schedule under `betaops2` (slug `beta-second`, units
`ghost-timer-v1-8-betaops2-beta-second.*`), confirm it is enabled, then:

```sh
ghost rm betaops2 --yes
ls "$D" | grep ghost-timer- | tee "$EV/06-units-after-delete.txt"
systemctl --user list-timers --all | grep ghost-timer-v1- || echo "no owned timers"
```

**Pass:** the same exact-name retirement, decoys still intact.

### 6.6 Clean up

```sh
rm -f "$D/ghost-timer-betaops-legacy.timer" "$D/ghost-timer-v1-8-betaopsx-neighbour.timer"
systemctl --user daemon-reload
```

**Record:** the unit texts, the `systemd-analyze` result, the journal, the
conversation transcript, and the before/after decoy hashes.

---

## Phase 7 — Upgrade, uninstall, reinstall, clean account

Capture a state fingerprint first — every step below must leave it unchanged:

```sh
{ ghost list; ghost sessions -g <ghost>;
  sha256sum ~/.local/state/ghost/api-token ~/.local/state/ghost/relay-token;
  find ~/ghosts -maxdepth 2 -type d | sort;
} > "$EV/07-state-before.txt"
```

### 7.1 Upgrade

```sh
sudo pacman -U <newer ghost-dev package> 2>&1 | tee "$EV/07-upgrade.log"
systemctl --user reenable --now ghostd.service ghost-shell.service
```

**Pass:** `post_upgrade` prints the Obsidian re-verification steps and the
`reenable` instruction; after reenable both units are wanted by
`graphical-session.target`, not `default.target`; the state fingerprint is
unchanged; the relay stays paired; conversations, private per-ghost memory, and
Obsidian notes/tasks are all still reachable (re-run §3.8 and one turn).

### 7.2 Uninstall

```sh
systemctl --user disable --now ghost-shell.service ghostd.service
sudo pacman -Rns ghost-dev 2>&1 | tee "$EV/07-remove.log"
ls /usr/lib/ghost /usr/share/ghost /etc/xdg/quickshell/ghost 2>&1
{ find ~/ghosts -maxdepth 2 -type d | sort;
  ls ~/.config/ghost ~/.local/state/ghost ~/.agents/skills/obsidian-cli;
} > "$EV/07-state-after-remove.txt"
diff "$EV/07-state-before.txt" "$EV/07-state-after-remove.txt"
```

**Pass:** package-owned `/usr` paths and the Quickshell symlink are gone;
`~/ghosts`, `~/.config/ghost`, `~/.local/state/ghost`, Secret Service items, the
Obsidian skill, and every vault are untouched; `pre_remove`/`post_remove` print
the disable instruction and the preservation note.

### 7.3 Reinstall

```sh
sudo pacman -U "$PKG"
systemctl --user enable --now ghostd.service ghost-shell.service
ghost status; ghost list; ghost model
```

**Pass:** the same ghosts, conversations, model selection, daemon token, and
relay pairing come back with no re-login.

### 7.4 Clean account

On a second local account (or a clean machine): log in graphically, unlock its
keyring, complete Phase 2 for that account, install the package, enable the two
units, and run one turn.

**Pass:** the new account gets its own empty `~/ghosts`, its own tokens, and its
own Obsidian registration; nothing leaks from the first account.
**Record:** `$EV/07-clean-account.md`.

### 7.5 Omarchy channel — blocked

Installing through the intended Omarchy channel requires a promoted stable
`ghost` package, which requires publication, which the hold forbids. Record this
gate as blocked on the hold, not as failed.

---

## Phase 8 — Evidence roll-up for #17

`$EV/` is the record; the candidate worktree and the extraction scratch are not.
Retire them once the evidence above is captured, from the working checkout:

```sh
cd ~/github.com/ferdousbhai/ghost
rm -rf ~/ghost-beta/scan
git worktree remove ~/ghost-beta/src
git worktree list          # no ~/ghost-beta/src row
```

Paste this into #17, one line per gate, filling in the evidence pointer:

```text
Candidate SHA: <sha>   Package: ghost-dev-<pkgver>-1-x86_64.pkg.tar.zst (sha256 <…>)
Machine: <host>, systemd <ver>, Omarchy <ver>

Candidate build
[ ] built from a clean worktree at the candidate SHA           — 00-worktree.txt
[ ] gitleaks: history + source/runtime/pkg extractions clean   — 01-secret-scan.txt

Obsidian readiness
[ ] clean-account install + official CLI registration       — 02-obsidian-version.txt, screenshot
[ ] upstream skill + obsidian version + SKILL.md            — 02-skill.txt
[ ] bounded manual evidence for the package                 — 02-accept-obsidian.log, 03-install.log

Installed native delegation
[ ] ghost delegation human/JSON/quiet, bounded + daemon-free — 04-delegation-*.txt
[ ] full task lifecycle, Pi and Claude                       — 04-lifecycle-*.md, 04-tasks.json
[ ] all three workers + truthful unavailable/logged-out      — 04-workers.md
[ ] delete with active work -> tasks_active; then Trash move  — 04-delete.txt
[ ] restart recovery/quiesce; unrelated units untouched       — 04-scopes-*.txt, 04-units.diff
[ ] systemd>=254 direct dependency (refusal: see Not covered) — .SRCINFO, pacman -Qi

Claude SDK boundary
[ ] runtime + installed package exclude SDK code             — 01-payload.txt, 01-runtime-smoke.log
[ ] no SDK -> Claude fails closed, Pi usable                  — 05-no-sdk.txt
[ ] exact graph installed -> principal + delegated, no creds  — 05-principal.md, 05-delegated.md, 05-no-creds.txt
[ ] removal/mismatch -> fails closed, no stale reuse          — 05-sdk-removed.txt

Scheduled work (disposable ghost)
[ ] unit names/content, systemd-analyze verify, enabled       — 06-units.txt, 06-timers.txt
[ ] fires -> one completed conversation via ghost say --new   — 06-journal.txt, 06-transcript.md
[ ] survives ghostd restart, fires exactly once               — 06-timers-after-restart.txt
[ ] rename retires exact old-name units only                  — 06-units-after-rename.txt, decoy diff
[ ] delete retires the same way                               — 06-units-after-delete.txt
[ ] artifacts removed, evidence retained                      — 06-*

Packaged owner acceptance
[ ] install, services, HUD/tray, login/model, Pi+Claude,
    three workers, helper, paired relay                       — 03-*
[ ] service/browser smoke; restart preserves state            — 03-service-smoke.log, 07-state-*.txt
[ ] upgrade / uninstall+reinstall / clean account             — 07-upgrade.log, 07-remove.log, 07-clean-account.md
[ ] public staging + Omarchy submission                       — BLOCKED on release hold
[ ] owner lifts the hold                                      — owner decision
```

---

## Not covered here

- **Owner decisions:** candidate freeze, version and scope selection (§1.6),
  authorizing live mutation, configuring a publication destination, lifting the
  release hold.
- **GUI steps:** Obsidian's CLI registration pane, HUD/tray appearance, the
  provider login window, Chromium **Load unpacked** and pairing, and visual
  computer-use results. Screenshots plus bounded traces are their evidence.
- **Model behaviour:** whether a ghost *chooses* the right operation in a turn.
  A deterministic script cannot stand in for a real provider turn.
- **`systemd < 254` refusal:** needs a separate pre-254 image; only the declared
  direct dependency is provable here.
- **Publication-time re-scan:** §1.5 scans the candidate worktree's history and
  the three extracted artifacts here. Re-running it against whatever a
  publication step finally uploads is out of scope because publication is.
- **Publication and Omarchy:** staging, publishing, anonymous URL verification,
  and the contribution's review/build/sign/promotion are external and
  hold-blocked.
- **SDK redistribution:** relying on the owner-installed graph is a distribution
  decision, not a probe. Bundling needs demonstrated rights; a CLI-transport
  substitute needs demonstrated feature and lifecycle parity.

## Follow-ups worth automating

None of these exist today; each would replace a hand-run block above.

- A packaged post-install readiness command that runs `accept-obsidian.sh`,
  `service-browser-smoke.sh`, and `ghost delegation` in one pass (belongs with
  #54).
- A delegated-task lifecycle harness driving `POST /sessions/:id/tasks` and its
  `send`/`cancel` routes against a scratch daemon, so §4.2 is scripted rather
  than narrated.
- A schedule-ownership harness that plants the legacy and prefix-neighbour
  decoys, renames and deletes a scratch ghost, and asserts exact-name retirement
  (§6.4–§6.5 are the manual version of `schedules.ts`'s unit tests).
- A `ghost` verb for renaming a ghost; §6.4 currently needs raw `curl` against
  `PUT /api/ghosts/:name/name`.
