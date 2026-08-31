# Public release publication

> **RELEASE HOLD:** this is a prospective operator procedure, not authority to
> publish. Do not create a release repository or tag, dispatch the release
> workflow, submit an Omarchy package, install on the owner's live machine, or
> publish any artifact until the owner explicitly lifts the hold and #17's
> affected gates have been repeated on the exact candidate.

## Distribution boundary

The working `ghost` repository remains private. The prospective public
`ferdousbhai/ghost-releases` repository is a new artifact channel, not a fork,
mirror, filtered copy, or push target for private history. Its `main` branch
contains only channel documentation and one release-binding record per version.
The versioned `ghost-<version>.tar.gz` asset is the sanitized public source
snapshot; GitHub's automatic source archives describe only the small delivery
repository and are not package inputs.

Ghost supplies source and runtime release inputs, not a Linux distribution:

- the public candidate contains only the sanitized source archive, runtime
  archive, runtime checksum, `RELEASE-METADATA.json`, `SHA256SUMS`, and an
  optional detached `SHA256SUMS.sig`;
- no pacman package, rolling checkout package, package database, repository
  metadata, or Ghost-owned package-signing key enters the channel;
- Omarchy reviews the contribution, builds and signs the stable `ghost`
  package, and decides when to promote it through Omarchy's own package path;
- `ghost-dev` remains a checkout-only rolling recipe. It provides and conflicts
  with `ghost` so the two package variants cannot be installed together.

The supported release target is Omarchy; there is no second package-index path
or generic Arch support promise.

## Prospective repository setup

Every item in this section is an **owner action after the release hold is
lifted**.

- Create public `ferdousbhai/ghost-releases` from a new empty history with
  default branch `main`. Add a short README that identifies it as an artifact
  channel and points source readers to the versioned sanitized source asset.
- Enable
  [release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
  before the first release; the setting does not apply retroactively.
- Protect `main` and the `release-candidates/v*` branch namespace. Candidate
  refs require active repository rules for deletion, update restriction with
  fetch-and-merge disabled, and non-fast-forward updates. Keep unused Issues,
  Discussions, Projects, and Wiki surfaces off.
- Create exactly two active repository-level tag rulesets. Both target `tag`,
  come from `ghost-releases`, and have the exact scope
  `include=["refs/tags/v*"]`, `exclude=[]`. One contains only `creation`; make
  the publication App its sole manually configured `always` bypass actor. The
  other contains exactly `update` (with fetch-and-merge disabled), `deletion`,
  and `non_fast_forward`, with no bypass actor. The workflow can read and check
  the two rulesets, but GitHub's read API does not expose their bypass actors:
  the bypass configuration is a manual owner attestation.
- Keep the private source repository's `master` protected. The release workflow
  is manual and accepts dispatches only when its exact workflow revision runs
  from protected `master`.
- Register a dedicated GitHub App with no webhooks and only **Contents: write**
  and **Administration: read** repository permissions, plus GitHub's implicit
  Metadata read. Install it only on `ghost-releases`, never on the private
  source repository or account-wide.
- In the private source repository, set repository Actions variable
  `GHOST_RELEASE_REPOSITORY=ferdousbhai/ghost-releases`; the credential-free
  verification job needs the destination identity before environment admission.
  Create the `public-release` environment, restrict deployment to protected
  `master`, set `GHOST_RELEASE_APP_CLIENT_ID` there, and store
  `GHOST_RELEASE_APP_PRIVATE_KEY` as its secret. The publication job must enter
  this environment before it can mint the App's short-lived token.
- Keep the workflow's `GITHUB_TOKEN` read-only. Never create, store, request, or
  fall back to a personal access token.

GitHub Free, Pro, and Team do not provide required environment reviewers for a
private repository. On those plans, the environment stores the publication
credential and may restrict deployment refs, but access to that credential is
not necessarily an independent human-approval gate. The authenticated draft
inspection and explicit publish dispatch remain owner procedures, not
platform-enforced two-person approval. If the repository later uses a plan that
supports private-repository reviewers, add a required reviewer without
weakening the other controls. See
GitHub's current
[environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
and
[GitHub App workflow guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow).

## Prospective workflow

The manual `Release candidate` workflow takes an exact successful Arch workflow
run on `master`, its 40-character source SHA, a prospective three-part version,
and one of `dry-run`, `stage`, or `publish`. The run attempt is part of the
candidate identity: both jobs download only
`ghost-public-candidate-<source-sha>-<run-attempt>` from that exact run ID, and
the candidate metadata binds the same attempt. An explicit destination is only
a confirmation and must exactly match the mandatory repository-level
`GHOST_RELEASE_REPOSITORY`. `publish` additionally requires both the exact
positive draft release ID and full `candidate_commit` returned by `stage` and
accepted by the owner.

1. `dry-run` verifies the protected-master orchestration identity, source run,
   source checkout, and sealed public-candidate inventory without receiving the
   App credential.
2. `stage` repeats those checks, enters `public-release`, redownloads and
   reverifies the candidate, then re-reads the protected `master` branch and ref
   after environment admission. Only then does it mint a destination-scoped App
   token and confirm that the destination is public, non-forked, and configured
   for immutable releases.
3. Staging creates one single-parent record commit on the then-current public
   `main` and the protected
   `refs/heads/release-candidates/v<version>/<parent-commit>` ref. It creates or
   resumes the uniquely bound draft, uploads only missing assets to that exact
   release ID's upload URL, and redownloads every present asset to verify its
   byte identity. It does not create or reserve the public `v<version>` tag or
   advance `main`.
4. **Owner action — authenticated draft review:** retain the candidate ref,
   full candidate commit, draft URL, and numeric release ID from the stage
   summary. With an authorized account, inspect and download the exact draft,
   verify every name and digest, inspect the source and metadata, and record the
   acceptance evidence. Draft URLs are not expected to work anonymously.
5. **Owner action — explicit publish dispatch:** start a separate `publish` run
   with the same source run, source SHA, version, destination, exact draft
   release ID, and the full accepted candidate commit. The workflow repeats the
   candidate and post-environment trust checks and refuses a different,
   ambiguous, incomplete, or rebound draft.
6. Publication follows three durable states. S0 is `main=P`, candidate `C` with
   sole parent P, exact complete draft R targeting C, and no version tag. The
   workflow reads the two exact tag rulesets, advances `main` from P to C with
   `force:false`, and fully revalidates S1: `main=C`, the same candidate lineage,
   draft, binding and asset inventory, and an unchanged absent tag. It reads the
   rulesets again and requires an identical snapshot. Only then does an exact
   release-ID `PATCH` change R from draft to published; GitHub creates the
   lightweight `v<version>` tag at C as part of publication. Strict S2 requires
   `main=C`, immutable published R, the unique tag at C, and the unchanged
   binding, lineage, and asset bytes. The workflow never pre-creates,
   reassigns, or otherwise reserves the tag.
7. **Owner action — post-publication acceptance:** independently confirm the
   Immutable marker, release and asset verification, checksums, and anonymous
   source/runtime URLs. Only then submit the reviewed contribution to Omarchy.
   Omarchy owns its build, package signature, repository promotion, and clean
   installation proof.

No step above authorizes a live owner-machine install. That remains a separate
owner acceptance action under #17 after the hold is lifted.

This protocol assumes one trusted administrator controls the destination and
has manually attested the bypass actors described above. The machine checks
detect a ruleset change between their two snapshots; they do not prove the
hidden bypass-actor configuration or protect publication against a malicious
repository administrator.

## Failure, withdrawal, and correction

- A transient `stage` failure may retry the same exact candidate. The workflow
  never overwrites an asset: it verifies existing bytes, uploads only missing
  names, and fails on any unexpected or mismatched asset.
- If candidate content or source identity changes before publication, repeat
  the affected gates and stage the corrected candidate. A correction creates or
  resumes a new single-parent record on current public `main` and rebinds the
  draft; it never rewrites the old candidate ref or force-pushes. The new
  `candidate_commit` invalidates the earlier owner acceptance.
- If publication fails before `main` advances, S0 is safe to retry. If `main`
  has advanced and the exact draft remains unpublished, strict S1 is safe to
  retry. If GitHub published despite an ambiguous response, the workflow accepts
  only complete S2 and proceeds to anonymous verification; every other mixed
  state fails closed.
- A published immutable release is historical evidence. Never replace an
  asset, move or reuse its tag, or reconstruct the same version. Withdraw it
  from Omarchy promotion, publish an advisory through metadata GitHub still
  permits changing, and issue the correction as a new patch version.
- If credential or private-data exposure requires deletion, rotate the exposed
  credential first. An immutable release's tag name remains consumed; the
  replacement still receives a new patch version.

## Evidence and attestation limits

The sanitized snapshot discloses the source selected for distribution, not the
private repository's history. A recipient cannot compare it independently with
the private candidate or audit omitted history. `RELEASE-METADATA.json` and the
checksum manifests bind the disclosed files to the recorded private source run;
they do not make that private-to-public selection independently auditable.

GitHub's immutable-release controls prevent the public tag and attached assets
from changing after publication; the binding commit and checksum manifest give
those bytes stable identities. Those controls are not an independent
attestation that the private build used the claimed source, that the build is
reproducible, or that an artifact is secure, secret-free, or license-complete.
A private-repository artifact attestation is also plan- and
authorization-dependent and does not use the public Sigstore transparency log.
A public ingestion workflow could attest the bytes it received, but not the
private build that produced them.

`SHA256SUMS.sig` authenticates the checksum manifest only when a recipient has
an independently trusted signer. Ghost currently owns no package-signing key;
Omarchy's later package signature covers the package Omarchy builds and
promotes, not Ghost's private source history. Retain the sanitized source,
metadata, checksums, anonymous verification, and Omarchy review alongside any
attestation or signature.

See GitHub's current descriptions of
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
[artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations),
and [release verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity).
