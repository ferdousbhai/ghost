# Cloudflare OS feature-gap analysis

Status: product and architecture recommendation

Snapshot analyzed: Cloudflare OS commit `14fea8592a6dbc59769d592c0752bbf6a465fa84`

This document compares Ghost with Cloudflare OS and identifies what Ghost should
borrow to reach comparable product completeness without giving up its defining
properties: multiple durable ghosts, owner-readable files, local execution on
Omarchy, broad OMP model support, and no required hosted control plane.

The Cloudflare OS links below point to the sibling checkout at
`github.com/tmp/cloudflare-os`. They work in the current development workspace;
they will not resolve in a standalone Ghost clone unless that checkout is
present. Cloudflare OS is still described as early access and is undergoing a
version-two rewrite, so this is a comparison with a useful architecture and
working implementation—not a promise that every surface is stable. Start with
its [README](../../../tmp/cloudflare-os/README.md) and repository-wide
[engineering guidance](../../../tmp/cloudflare-os/AGENTS.md).

This report complements the [Grok Bot feature-gap analysis](GROK_BOT_FEATURE_GAP.md).
The Grok comparison is strongest on multi-agent messaging, routines, background
work, and desktop product polish. Cloudflare OS adds a different missing axis:
an AI software factory with sandboxed apps, transactional code changes,
object-capability resource access, deferred side effects, reusable blueprints,
and information-flow-aware sharing. These should become one architecture, not
two parallel permission and scheduling systems.

## Executive conclusion

Ghost is already ahead where its product is deliberately different:

- a ghost is a durable, portable persona with character and long-term memory;
- several independent ghosts coexist on one laptop;
- ghost homes, memories, documents, and projects remain visible as ordinary
  owner files;
- OMP provides multi-provider model routing, fallback, native filesystem work,
  and branchable conversations;
- Ghost is integrated with Omarchy, the owner's browser, a ghost-owned browser,
  the desktop, voice, keyring credentials, and encrypted conversation sharing;
  and
- unsafe executable extensions and Pi task agents are intentionally withheld
  until an isolation boundary exists.

Cloudflare OS is substantially ahead at letting an agent safely create and
operate software. Its most valuable features are:

1. **Gadgets**: every generated app or document can have its own code, UI,
   server, storage, typed agent API, sandbox, and lifecycle.
2. **Transactional AI editing**: each chat works on a draft, streams proposed
   changes, previews them live, and merges or discards them explicitly.
3. **Gatekeepers**: an agent receives named capabilities for exact resources
   instead of ambient credentials or a broad integration.
4. **Observation and action mediation**: reads are audited, writes are staged,
   simulations let work continue before approval, and retries avoid duplicate
   external side effects.
5. **Blueprints and outputs**: apps can be templated safely and their products
   are first-class, searchable, exportable objects.
6. **Information-flow-aware sharing**: collaborators do not inherit the
   owner's accounts, and external data is not shared without verifying that the
   recipient may observe it.
7. **Durable hooks and scoped agents**: schedules and event callbacks retain
   narrow authority, while spawned agents see only deliberately introduced
   bindings.

The highest-value target is therefore not a Cloudflare OS clone. It is a local
**Ghost Workspace** in which one or more ghosts can safely build apps and
artifacts, use exact local or remote resources, stage side effects, and hand the
owner a complete diff and activity trail. Plain files stay authoritative;
systemd, bubblewrap, local Git, Secret Service, Unix sockets, and the existing
Ghost shell replace Workers, Durable Objects, R2, and the hosted web shell.

## What “feature parity” should mean

Cloudflare OS is primarily a user-to-workspace-to-agent product. Ghost is a
user-to-many-durable-personas product. Literal parity would erase Ghost's main
advantage, so the correct target is capability parity:

- a ghost can create, run, revise, export, and template a useful application;
- code and data are isolated from the owner unless deliberately granted;
- external resources are introduced as narrow, inspectable capabilities;
- reads and writes have provenance, and irreversible writes are never replayed
  blindly;
- scheduled, delegated, and callable work survives restarts and remains
  observable;
- another ghost or human can use an artifact without inheriting persona memory,
  credentials, or unrelated resource access; and
- everything remains usable on one Omarchy laptop without a Cloudflare account
  or hosted service.

Parity does **not** require Cloudflare's multi-tenant administration, billing,
public marketplace, global analytics, or Workers deployment substrate. It also
does not mean replacing OMP, Quickshell, plain files, or permanent ghosts.

## Current Ghost baseline

The following existing contracts constrain and simplify the design:

- [PLAN.md](PLAN.md) defines Ghost as an owner-local desktop application rather
  than a network-facing agent service and explicitly holds executable project
  extensions and Pi subagents behind an isolation milestone.
- [CONTRACTS.md](../CONTRACTS.md) makes the plain-file ghost home authoritative,
  keeps project trust machine-local, resolves keyring references only in
  memory, and specifies conversation, memory, MCP, browser, desktop, hook, and
  collaboration boundaries.
- [packages/daemon/README.md](../packages/daemon/README.md) documents the live
  OMP session store, immutable admitted project resources, keyring behavior,
  memory maintenance, and the distinction between Pi and Claude runtimes.
- [packages/shell/README.md](../packages/shell/README.md) documents the native
  Omarchy UI, project draft behavior, branching, context management, voice, and
  encrypted conversation collaboration.
- The [Grok Bot report](GROK_BOT_FEATURE_GAP.md) already recommends a local
  capability broker, isolation, durable scheduling, an activity inbox,
  multi-ghost messaging, routines, attachment staging, and extension install
  flows. Cloudflare OS supplies stronger semantics for several of those
  primitives.

Ghost should extend these contracts rather than create an unrelated app store
or cloud-compatible state model beside them.

## Cloudflare OS architecture in one page

Cloudflare OS describes an office-suite-like system where every document can be
a private, customizable app. Its own analogy maps the backend to a kernel,
Gatekeepers to drivers, the web frontend to a shell, Gadgets to processes, and
Blueprints to executables. The useful implementation boundaries are:

| Layer | Cloudflare OS implementation | Lesson for Ghost |
| --- | --- | --- |
| Public contracts | [workshop-shared API](../../../tmp/cloudflare-os/packages/workshop-shared/src/api.ts), [Gatekeeper API](../../../tmp/cloudflare-os/packages/workshop-shared/src/gatekeeper.ts), and [code-change model](../../../tmp/cloudflare-os/packages/workshop-shared/src/code-change.ts) | Specify lifecycle and authority at boundaries, not as UI conventions |
| Workspace kernel | [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts) | One authority owns apps, drafts, actions, bindings, hooks, sharing, and recovery |
| Agent runtime | [agent.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent.ts) and [agent compaction](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent-compaction.ts) | Give code mode only named capabilities and commit a logical step atomically |
| App runtime | [Gadget worker loading](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts) and [sandboxed UI host](../../../tmp/cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx) | Isolate generated server and client code independently |
| Resource drivers | `packages/gatekeeper-*`, coordinated by the [Gatekeeper contract](../../../tmp/cloudflare-os/packages/workshop-shared/src/gatekeeper.ts) | Introduce exact resource objects; do not inject whole accounts or ambient tools |
| Approval/activity | [action persistence in the Overseer](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts), [auto-approval](../../../tmp/cloudflare-os/packages/workshop-backend/src/auto-approval.ts), and [Activity UI](../../../tmp/cloudflare-os/packages/workshop-frontend/src/Activity.tsx) | Treat observations and side effects as durable product objects |
| Templates and sharing | [Blueprints](../../../tmp/cloudflare-os/docs/blueprints.md), [sharing model](../../../tmp/cloudflare-os/docs/sharing.md), and [observer model](../../../tmp/cloudflare-os/docs/observers.md) | Copy code without copying data or authority; account for who may see observed data |

This separation is more important than the specific Cloudflare technologies.

## Recommended Ghost object model

The largest structural change is to add a workspace below the owner but outside
any one ghost home. A conversation-bound project is currently the closest Ghost
concept, but it does not own generated apps, bindings, approvals, schedules, or
multi-ghost work as one durable security boundary.

| Object | Proposed meaning in Ghost | Portability and authority |
| --- | --- | --- |
| **Ghost** | Durable persona, character, personal memory, model preferences, and declarative skills | Exportable; carries no machine grants or credentials |
| **Workspace** | Local task/security boundary containing trusted roots, artifacts, conversations, bindings, policies, and audit history | Machine-local by default; shareable only through a restricted projection |
| **Run** | Durable unit of interactive, delegated, callable, or scheduled work with one acting ghost and one initiator | Holds a snapshot of granted capability handles, budgets, and idempotency IDs |
| **Ghost App** | Generated mini-application or interactive document with source, data, UI, service, exports, and a manifest | Source is visible and portable; data and active bindings are separate |
| **Artifact** | A file, report, patch, image, app result, or export produced by a run | Plain file is authoritative; index and previews are derived |
| **Binding** | Opaque handle to an exact folder, repository, account resource, tool subset, model, or callback | Machine-local; never included in a ghost or Blueprint export |
| **Observation** | Audited external datum delivered through a binding | Records source/provenance and sharing restrictions, not secret material |
| **Action** | Proposed external side effect with simulation, approval, apply, result, and optional revert | Durable and at-most-once at the broker boundary |
| **Blueprint** | Versioned source plus required binding descriptions and metadata | Contains no app data, transcripts, memory, credentials, grants, or enabled hooks |

Several ghosts may work in one workspace, but the workspace does not merge their
identities or memories. Each run names its actor and receives an explicit subset
of workspace bindings. A delegated ghost never acquires every capability of the
sender merely because both can see the same artifact.

## Comparison at a glance

| Area | Ghost today | Cloudflare OS pattern | Local-first recommendation |
| --- | --- | --- | --- |
| Agent identity | Multiple durable personas with plain-file memory | Agent is mostly scoped to a workspace/chat | Keep Ghost; add workspace-scoped runs |
| App creation | OMP can edit projects directly | Sandboxed full-stack Gadgets | Build Ghost Apps from visible files in isolated local services |
| Code review | Project changes are ordinary filesystem changes | Per-chat draft, live preview, OT, three-way accept/discard | Add transactional worktrees and patch review |
| Resource access | Trusted project plus MCP and native tools | Named object capabilities from Gatekeepers | Build one machine-local binding broker |
| Side effects | Tool-specific execution and current trust checks | Audited observations, staged/simulated actions | Make action mediation a shared daemon service |
| MCP | OMP-native servers with admission and keyring references | Central classification, safe fetch, scoped catalogs, at-most-once writes | Port the trust-boundary concepts, adapted for local stdio risk |
| Background work | Hooks and idle maintenance; full routines pending | Persistent hooks and a durable scheduler Gatekeeper | Use daemon state plus systemd wake sources |
| Subagents | Pi disabled pending isolation; Claude native behavior retained | Spawned/callable agents get a configured environment only | Create ephemeral runs under permanent ghosts with exact binding envelopes |
| Templates | Declarative skills and ghost exports | Versioned Blueprints clone code and requirements only | Separate executable app Blueprints from prompt skills |
| Outputs | Plain files and desktop open/save behavior | Global searchable Outputs and bounded export pipelines | Index plain artifacts; export through sandboxed local tools |
| Sharing | Encrypted conversation collaboration | Build/use roles plus resource-observer checks | Share workspace projections, never ghost identity or owner authority |
| Context | Character, memory, documents, project, skills | Private/public collections and bounded agent catalogs | Add owner-curated context collections while keeping files authoritative |
| Connectors | Browser, desktop, MCP, project, keyring foundations | Many typed Gatekeepers | Build the connector platform first; prioritize local-native resources |
| Operations | Local daemon and native shell | Hosted admin, quotas, releases, health, telemetry | Borrow health, recovery, limits, and rollback—not hosted operations |

## 1. Sandboxed Ghost Apps

### What Cloudflare OS demonstrates

A Gadget is not merely a code attachment. It has source files, server code,
client UI, storage, named bindings, a typed RPC surface for agents, preview and
published revisions, export formats, and sharing roles. The backend loads each
Gadget as a Dynamic Worker with outbound access disabled by default. The UI is
loaded into a sandboxed iframe with a restrictive Content Security Policy and
communicates across a narrow `MessageChannel` RPC bridge.

Implementation references:

- [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  implements Gadget worker loading, chat-specific draft previews, UI-bundle
  retrieval, named bindings, and `globalOutbound: null`.
- [GadgetUI.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx)
  constructs the iframe CSP and sandbox, brokers RPC and console messages, and
  constrains popup behavior.
- [agent.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent.ts)
  exposes app creation, file reading/writing/editing, code execution, binding,
  and connection requests to the agent.
- [api.ts](../../../tmp/cloudflare-os/packages/workshop-shared/src/api.ts)
  documents the Gadget, chat, change-stream, binding, and Overseer interfaces.
- [GadgetCodeInterface.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/GadgetCodeInterface.tsx)
  and [GadgetEditor.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/GadgetEditor.tsx)
  show how code, preview, and conversation become one product surface.

### What Ghost should build

A Ghost App should be a normal owner-visible directory, for example:

```text
workspace/
  apps/<app-slug>/
    ghost-app.json
    ui/
    service/
    data/                 private runtime data, excluded from Blueprint export
    exports/
```

The manifest should declare source entry points, RPC methods, output formats,
required bindings, schema version, runtime class, resource limits, and whether
network access is needed. Generated source remains editable with ordinary tools
and can live in an existing Git project when the owner chooses.

Run service code in a transient user service with bubblewrap, resource limits,
a minimal environment, a private writable state directory, and no network by
default. Expose only a loopback or Unix-socket broker whose capability handles
are scoped to that app and run. A crash must not affect `ghostd` or another app.

Arbitrary generated HTML/JavaScript should not execute inside the privileged
Quickshell process. Prefer a ghost-owned, sandboxed browser/PWA window for app
UI. The native HUD can show status and a trusted preview frame or launch action,
but generated QML should not become an in-process plugin. If Qt WebEngine is
later adopted, it still needs a separate profile, opaque origin, strict CSP,
disabled network, and a tiny message bridge.

The local implementation does not need to emulate Workers or Durable Objects.
A versioned, typed JSON-RPC protocol is sufficient initially; Cap'n Web is worth
studying for capability semantics, not as a mandatory dependency.

### Definition of done

An owner can ask a ghost for a small app, inspect its visible source, preview it
without granting filesystem or network access, close and reopen it after a
daemon restart, grant one exact resource, export its output, and delete or
archive app data independently of the ghost.

## 2. Transactional AI changes and versioning

### What Cloudflare OS demonstrates

Cloudflare OS treats model edits as a transaction. A chat is pinned to a base
revision; user and agent changes form a validated revision stream; proposed code
can run in preview without becoming mainline; and accept performs a merge if the
mainline moved. Provisional apps and bindings are promoted only when the draft
is accepted. Crashes can be reconciled because the durable log and content
store define what committed.

Implementation references:

- [code-change.ts](../../../tmp/cloudflare-os/packages/workshop-shared/src/code-change.ts)
  defines and validates wire-level code changes and their apply, compose,
  transform, and diff behavior.
- [git-store.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/git-store.ts)
  stores content-addressed Git objects and implements three-way merging.
- [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  implements `submitCodeChange`, step commits, draft finalization, merge,
  discard, revert, deduplication, revision generations, and crash recovery.
- [code-preview.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/code-preview.ts)
  streams bounded provisional edits and code previews while a tool step runs.
- [otClient.ts](../../../tmp/cloudflare-os/packages/workshop-frontend/src/otClient.ts),
  [CodeEditor.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/CodeEditor.tsx),
  and [CodeDiffEditor.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/CodeDiffEditor.tsx)
  implement collaborative editing and human review.

### What Ghost should build

Do not introduce a hidden second source of truth for owner projects. Use:

- a Git worktree or temporary branch for a project already in Git;
- an internal, workspace-local Git history or durable patch journal for a
  generated non-Git app;
- an overlay/staging tree for other owner files; and
- atomic rename or Git merge only after owner acceptance.

Every isolated run receives an immutable base revision and writes to a draft.
The shell should show created, edited, moved, and deleted files plus any
generated app preview. Accept may fast-forward or three-way merge; conflicts
return to review. Reject discards the draft without touching mainline. Recovery
must distinguish an uncommitted sandbox, an accepted transaction awaiting
publication, and a publication whose outcome is uncertain.

For app creation, approval can be the normal final step. For an explicitly
trusted interactive coding conversation, the owner may enable visible “direct
mode,” but it should be a named execution class rather than an accidental bypass.
Partial acceptance should wait until dependencies between file changes and
bindings can be recalculated safely.

This change also gives multi-ghost work a sane concurrency model: each run edits
its own base/draft, and the workspace—not whichever ghost finishes last—merges
results.

## 3. Exact resource bindings and connection requests

### What Cloudflare OS demonstrates

A Gatekeeper is a driver for an external vendor or resource. The agent does not
receive an OAuth token or a universal vendor client. It sees a named binding to
one resource-shaped capability. If it needs another resource, it calls
`requestConnection` with a vendor, resource URL, reason, and desired binding
name; the user selects/configures the resource, and the resumed agent sees the
new binding.

Implementation references:

- [gatekeeper.ts](../../../tmp/cloudflare-os/packages/workshop-shared/src/gatekeeper.ts)
  defines vendors, supported resource URL patterns, configuration UIs, accounts,
  Gatekeeper sessions, observations, actions, hooks, and bounded agent catalogs.
- [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  starts Gatekeeper sessions, creates named loopback bindings, authorizes
  observations, stages actions, and fulfills connection requests.
- [agent.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent.ts)
  gives the model progressive discovery (`describeBinding`, vendor resource
  patterns, and `requestConnection`) instead of a huge ambient tool catalog.
- [GatekeeperModal.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/GatekeeperModal.tsx),
  [ResourcePicker.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/ResourcePicker.tsx),
  [ResourceConfiguratorHost.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/ResourceConfiguratorHost.tsx),
  and [Connections.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/Connections.tsx)
  demonstrate account, resource, and binding UX.

### What Ghost should build

The local capability broker proposed in the Grok report should adopt this
object-capability shape. A policy such as “GitHub allowed” is too broad. A
binding should identify an exact object and interface, such as:

- read-only tree access to `/home/owner/projects/site`;
- read/write access to one GitHub repository but not the whole account;
- a single email thread, calendar, Home Assistant area, or Notion database;
- a browser tab or ghost-owned browser profile;
- a named MCP server plus an allowlist of tool names; or
- a callback that may enqueue one bounded run.

The broker should return opaque handles over a Unix socket. Model code can
invoke the interface but cannot inspect credentials, file descriptors, process
environment, raw D-Bus, or the owner's complete filesystem. Bindings are
machine-local records. Ghost homes and Blueprints may declare requirements, but
imports never confer grants.

The shell needs a connection-request card that shows the acting ghost, exact
resource, reason, requested operations, recipient app/run, persistence, and
sharing implications. “Allow once,” “for this run,” “for this workspace,” and a
narrow durable grant are useful; a global “always allow vendor” is not.

## 4. Observations, deferred actions, simulation, and audit

### What Cloudflare OS demonstrates

Cloudflare OS applies mediation in both directions:

- a Gatekeeper calls `authorizeObservation` before external data is returned to
  the app or model;
- a write becomes a durable pending action rather than executing immediately;
- a Gatekeeper may simulate the write in its session, so later reads reflect the
  proposed state and the agent can finish its task before owner review;
- if simulation is impossible, the turn waits for a decision and can resume
  after approval;
- actions have stable kinds, labels, resource identity, attribution, state, and
  optional revert behavior; and
- auto-approval requires both connector-authored eligibility and an explicit
  user rule, and it drains in order until a manual gate is reached.

Implementation references:

- [ApprovalQueue, ObservationDescription, and ActionDescription](../../../tmp/cloudflare-os/packages/workshop-shared/src/gatekeeper.ts)
  define the central contract.
- [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  persists observations/actions and handles submit, approve, reject, apply,
  resume, and notification behavior.
- [auto-approval.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/auto-approval.ts)
  is a small ordered, single-flight approval drain.
- [Activity.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/Activity.tsx),
  [ActivityNotifications.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/ActivityNotifications.tsx),
  [useActions.ts](../../../tmp/cloudflare-os/packages/workshop-frontend/src/useActions.ts),
  [useActionHistory.ts](../../../tmp/cloudflare-os/packages/workshop-frontend/src/useActionHistory.ts),
  and [useAutoApproval.ts](../../../tmp/cloudflare-os/packages/workshop-frontend/src/useAutoApproval.ts)
  show the review and activity surface.
- Connector-specific simulations are useful in
  [Google](../../../tmp/cloudflare-os/packages/gatekeeper-google/src/google.ts),
  [Confluence](../../../tmp/cloudflare-os/packages/gatekeeper-confluence/src/confluence-actions.ts),
  [Notion](../../../tmp/cloudflare-os/packages/gatekeeper-notion/src/notion-actions.ts),
  and [Home Assistant](../../../tmp/cloudflare-os/packages/gatekeeper-homeassistant/src/simulation.ts).

### What Ghost should build

Use a durable action state machine such as `proposed`, `waiting`, `approved`,
`applying`, `applied`, `rejected`, `failed`, `outcome_unknown`, and `reverted`.
Each action records the acting ghost/run, exact binding, stable action kind,
redacted arguments, dependency IDs, simulation summary, approving owner, and an
idempotency key. The audit log also records denied and failed attempts.

Each connector must declare its honest behavior:

- `simulate`: subsequent reads can reflect a pending mutation;
- `await`: agent execution must pause until a decision;
- `revert`: a defined inverse is available after application; or
- `irreversible`: review must say so plainly.

Do not fake simulated success for a generic command. Local file edits naturally
simulate inside the draft overlay. Email, issue, calendar, and smart-home
connectors need domain-specific models. An external action should be staged as
the exact request that will be sent, not regenerated by the model after approval.

Durable auto-approval rules belong to machine policy. Scope them to a binding,
action kind, acting ghost or workspace, argument constraints, and optional
expiry. The recipient of a delegated task does not inherit the sender's rules.
Redact secret values and sensitive payload bodies from the audit record while
retaining enough hashes and metadata to explain what occurred.

## 5. Hardened MCP as a shared trust boundary

### What Cloudflare OS demonstrates

`mcp-shared` centralizes security-sensitive MCP decisions instead of letting
each integration interpret protocol metadata differently. Its
[README](../../../tmp/cloudflare-os/packages/mcp-shared/README.md) is a compact
threat-model and limits inventory.

Notable implementation details:

- [tools.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/tools.ts) is the
  one classifier for read versus write annotations. Unknown tools become
  actions; auto-apply is restricted to a vetted endpoint tier plus suitable
  non-destructive/idempotent annotations.
- [scope.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/scope.ts)
  constrains a connection to a server or named tools and validates the current
  catalog against the grant.
- [catalog.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/catalog.ts)
  and [tool-search.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/tool-search.ts)
  bound and progressively expose tool catalogs.
- [endpoint.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/endpoint.ts)
  validates endpoints, while [fetch.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/fetch.ts)
  manually validates every redirect, strips cross-origin authorization/session
  headers, refuses unsafe body replay, and caps time and response size.
- [action-store.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/action-store.ts)
  claims writes before I/O. A restart from `applying` produces an unknown
  outcome rather than repeating a possibly completed side effect.
- [session.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/session.ts)
  sends every invocation through the same observation/action path.
- [sharing-policy.ts](../../../tmp/cloudflare-os/packages/mcp-shared/src/sharing-policy.ts)
  refuses collaborator sharing when the connector cannot verify recipient
  access.

### What Ghost should build

Port the semantics, not the Worker code:

- one daemon classifier for MCP tool annotations and endpoint trust tiers;
- unknown or changed tools default to staged actions;
- a catalog fingerprint invalidates stale tool grants;
- exact server/tool scopes and bounded progressive discovery;
- prompt/UI injection neutralization for untrusted server descriptions,
  schemas, labels, and proposed arguments;
- at-most-once action claims with an explicit unknown-outcome state;
- bounded time, request, result, and catalog sizes; and
- one audit/approval route shared with native Ghost connectors.

For remote HTTP MCP, retain redirect-by-redirect validation, DNS-rebinding
defense, cross-origin credential stripping, and private-network policy. Local
stdio MCP has less SSRF risk but much greater process, environment, and
filesystem authority; launch it in the same per-session sandbox, pass an
environment allowlist, and grant directories explicitly. Ghost's current
keyring-reference contract remains the credential source.

## 6. Persistent hooks and scheduler semantics

### What Cloudflare OS demonstrates

The Gatekeeper contract separates callback registration from owner enablement.
A persistent hook stores a controller, but every delivery starts a fresh
Gatekeeper session and receives a fresh approval queue. Revoking the hook,
account, or resource therefore removes future authority.

The scheduler supports elapsed intervals, explicit-time-zone wall-clock
recurrences, and one-shots. It preserves recurrence phase, skips missed work,
uses a stable run ID across retries, performs admission before every attempt,
persists before callback RPC, bounds concurrency, retries with exponential
backoff, and fences stale completions after disable/re-enable.

Implementation references:

- [hook interfaces in gatekeeper.ts](../../../tmp/cloudflare-os/packages/workshop-shared/src/gatekeeper.ts)
  define `bindHook`, `HookController`, and `HookInitiator`.
- The [scheduler README](../../../tmp/cloudflare-os/packages/gatekeeper-scheduler/README.md)
  documents time-zone, DST, missed-run, retry, idempotency, limit, and lifecycle
  semantics unusually well.
- [scheduler.ts](../../../tmp/cloudflare-os/packages/gatekeeper-scheduler/src/scheduler.ts)
  defines the agent API and hook controller.
- [scheduler-core.ts](../../../tmp/cloudflare-os/packages/gatekeeper-scheduler/src/scheduler-core.ts)
  validates schedules and handles calendar calculation.
- [driver-state.ts](../../../tmp/cloudflare-os/packages/gatekeeper-scheduler/src/driver-state.ts)
  defines the durable state machine and retry transitions.
- [schedule-driver.ts](../../../tmp/cloudflare-os/packages/gatekeeper-scheduler/src/schedule-driver.ts)
  implements admission, persistence, delivery, retry, disable, and run fencing.

### What Ghost should build

Use systemd timers, path units, and local connector watchers as wake sources,
but keep the daemon's durable run state authoritative. A routine or event hook
must contain:

- explicit time zone and DST semantics for wall-clock schedules;
- stable run and side-effect idempotency IDs;
- registration separate from owner enablement;
- a narrower background capability set than interactive use;
- admission revalidation before every delivery and action;
- bounded retries, concurrency, runtime, tokens, and provider spend;
- disabled, active, retrying, completed, dead, and revoked states; and
- owner-visible run history and next-run explanation.

Cloudflare's initial scheduler deliberately skips missed work. A laptop product
needs an explicit per-routine policy: skip, run once after wake, or bounded
catch-up. The UI should explain suspend and offline behavior. Ghost should also
implement run history and editing early; Cloudflare lists both among scheduler
future work.

This scheduler should be the same primitive used by routines, multi-ghost
deliveries, approval resumption, memory maintenance, hook callbacks, and app
tasks.

## 7. Scoped ephemeral and callable agents

### What Cloudflare OS demonstrates

A Gadget can receive an Agent Spawner binding configured with a selected subset
of the workspace environment. It may create an asynchronous agent chat or a
callable agent stub, but the child sees only those configured bindings—not the
entire parent workspace. The callable form makes agent work look like a typed
capability rather than an ambient autonomous process.

Implementation references:

- [AgentSpawnerConfig in api.ts](../../../tmp/cloudflare-os/packages/workshop-shared/src/api.ts)
  defines the configured environment.
- [agent-spawner-binding.d.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent-spawner-binding.d.ts)
  defines the runtime-facing spawn interface.
- [AgentSpawner implementation in overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  snapshots named bindings and creates restricted child sessions.
- [AgentSpawnerConfigForm.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/gatekeeper-modal/AgentSpawnerConfigForm.tsx)
  exposes selection of the child environment.

### What Ghost should build

Keep permanent ghosts as the identity layer. A subtask should create an
ephemeral **run under a selected ghost**, not an untracked new persona. The
delegation envelope names exact input artifacts, binding handles, allowed
actions, output schema, deadline, token/cost budget, depth, and parent run.

Support two modes:

1. An asynchronous task whose transcript and result appear in the activity
   inbox.
2. A callable contract with typed input, typed result, explicit failure, and a
   stable call ID.

Per-call resource handles are particularly valuable—for example, an email
summarizer receives one message/thread object rather than general mailbox
access. Multi-ghost fan-out, loop, depth, and budget limits from the Grok report
still apply.

Pi's task tool should remain disabled until this external Ghost boundary can
enforce isolation and capabilities. Claude's native subagents may remain a
runtime feature, but effects that need Ghost guarantees must be routed through
the same workspace broker and attributed to the parent run.

## 8. Blueprints without authority transfer

### What Cloudflare OS demonstrates

A Blueprint captures an app's source and binding requirements, not its SQLite
data, chat history, credentials, live binding objects, or authorizations. It can
have multiple retained versions; instantiation creates fresh storage and fresh
binding choices. Import/export uses a versioned archive with magic bytes,
lengths, validation, and size limits.

Implementation references:

- [blueprints.md](../../../tmp/cloudflare-os/docs/blueprints.md) describes the
  product lifecycle and the deliberate code/data boundary.
- [blueprint-archive.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/blueprint-archive.ts)
  validates the portable archive format.
- [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  implements publication, versioning, instantiation, propagation, and retry.
- [BlueprintModal.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/BlueprintModal.tsx),
  [BlueprintLandingPage.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/BlueprintLandingPage.tsx),
  and [BlueprintsPage.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/BlueprintsPage.tsx)
  demonstrate preview, creation, and catalog UX.

### What Ghost should build

A Ghost App Blueprint should contain a manifest, source tree, output contract,
required binding descriptions, schema version, checksums, provenance, and
optional signature. It must exclude:

- app runtime data and caches;
- ghost character, memory, or conversation transcripts;
- credentials, keyring references, and active bindings;
- approval and auto-approval rules;
- enabled schedules/hooks; and
- owner paths that have not been explicitly parameterized.

Import shows the source and requirements, treats code as untrusted, creates a
fresh sandbox, and asks for new bindings only when used. Start with a local
catalog and ordinary Git sharing; a hosted marketplace is unnecessary. Retain
stable Blueprint IDs and versions so updates can be shown as diffs and data
migrations can be reviewed.

Keep Ghost's declarative skills distinct. A skill supplies bounded
instructions; a Blueprint supplies executable app source and a resource
contract. A skill may create an app from a Blueprint, but installing one should
not silently install the other.

## 9. Outputs and bounded export

### What Cloudflare OS demonstrates

Cloudflare OS has a global Outputs surface across workspaces and supports
declared app export formats. Browser-based export executes in a network-isolated
renderer with bounded RPC, streaming, timeout, and screenshot behavior.

Implementation references:

- [outputs.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/routes/outputs.tsx)
  aggregates, searches, filters, and opens outputs across workspaces.
- [gadget-export.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/gadget-export.ts)
  validates app-declared formats and bounds export streams.
- [browser-export.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/browser-export.ts)
  implements isolated HTML, PDF, PNG, and JPEG rendering.
- [GadgetExportMenu.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/GadgetExportMenu.tsx)
  and [fileTransfers.ts](../../../tmp/cloudflare-os/packages/workshop-frontend/src/fileTransfers.ts)
  cover selection and bounded transfer behavior.

### What Ghost should build

Create an owner-wide Artifacts/Outputs view across ghosts and workspaces. Each
entry references an ordinary file and records producing run, ghost, workspace,
source revision, MIME/type, creation time, and optional app. Search metadata in
a disposable index; the files remain authoritative.

Export HTML/PDF/images through a headless ghost-owned browser with network
disabled and strict time, size, and page limits. Use sandboxed local converters
for office formats. Save through the desktop portal or an explicit owner path,
and open normal files through `xdg-open` rather than rebuilding an office suite
inside QML.

## 10. Sharing and information-flow control

### What Cloudflare OS demonstrates

Cloudflare OS separates “build” and “use” roles by handing collaborators
different capability objects, not merely checking a role string in every
method. A collaborator uses their own model/account for any added bindings and
does not inherit the owner's credentials. Sharing maintains a permission graph,
can preview revocation impact, and resets live sessions when authority changes.

The observer system handles a subtler risk: data read through a Gatekeeper may
appear in an app shared with someone else. Gatekeepers can verify that each
observer may access the underlying resource or exclude particular observers.
If a connector cannot make that guarantee, sharing can be prohibited. This is a
coarse fallback, but the information-flow question is essential.

Implementation references:

- [sharing.md](../../../tmp/cloudflare-os/docs/sharing.md) and
  [sharing.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/sharing.ts)
  define roles, permission propagation, links, and revocation.
- [observers.md](../../../tmp/cloudflare-os/docs/observers.md) and the observer
  interfaces in [gatekeeper.ts](../../../tmp/cloudflare-os/packages/workshop-shared/src/gatekeeper.ts)
  define resource-access verification.
- [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
  implements observer authorization and the `prohibitAllSharing` lockdown.
- [ShareModal.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/ShareModal.tsx),
  [ObserverConfigModal.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/ObserverConfigModal.tsx),
  and [GadgetPresence.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/components/GadgetPresence.tsx)
  show sharing, data-recipient, and presence UX.

### What Ghost should build

Share a workspace projection, conversation, app, or output—not a live ghost
identity or its long-term memory. Useful roles are `view`, `use`, `review`, and
`build`. Remote collaborators never inherit the owner's filesystem, desktop,
browser session, keyring, model accounts, or background grants.

Ghost can keep its encrypted relay and owner-issued links rather than adopt
hosted identity. A link should carry a role, target, expiration, and revocation
ID, then establish a restricted capability after authentication. The owner
keeps the authoritative files; a remote client sees a deliberate projection.

Every externally sourced observation should retain provenance and a sharing
classification. Before it enters a shared transcript or app, the connector
must either verify every recipient, produce a redacted/per-recipient view, or
block the observation and explain why. A connector unable to verify access can
mark the whole workspace owner-only, but finer per-artifact and per-thread
labels are preferable to Cloudflare's all-sharing lockdown.

Real-time OT is useful for code and text artifacts, provided accepted changes
commit back to plain files. Presence should be optional and privacy-conscious.

## 11. Context collections and bounded skill discovery

### What Cloudflare OS demonstrates

The Context Library presents named collections that can be searched and read
through a Gatekeeper. Every returned datum is an observation. Agent catalogs
are bounded, collections are discovered before their skills, skill frontmatter
is validated, and Git-backed artifact synchronization has transfer and body
limits.

Implementation references:

- [library-gatekeeper.ts](../../../tmp/cloudflare-os/packages/gatekeeper-context/src/library-gatekeeper.ts)
  defines accounts, collections, sessions, and agent catalogs.
- [library-read.ts](../../../tmp/cloudflare-os/packages/gatekeeper-context/src/library-read.ts)
  bounds concurrent reads and results.
- [context-types.ts](../../../tmp/cloudflare-os/packages/gatekeeper-context/src/context-types.ts)
  and [context-api.ts](../../../tmp/cloudflare-os/packages/gatekeeper-context/src/context-api.ts)
  define collection and document contracts.
- [agent-skill.ts](../../../tmp/cloudflare-os/packages/gatekeeper-context/src/agent-skill.ts)
  parses, validates, and presents skill metadata.
- [artifact-sync.ts](../../../tmp/cloudflare-os/packages/gatekeeper-context/src/artifact-sync.ts)
  implements bounded Git artifact synchronization.

### What Ghost should build

Add named, owner-curated context collections: selected Documents folders,
repositories, notes, manuals, and team materials. A collection may be available
to one ghost, several ghosts, or one workspace/run. Reads should carry exact
document IDs and provenance into the activity/audit model.

Preserve Ghost's no-authoritative-index rule. Scan bounded directories or build
a disposable runtime index under `$XDG_RUNTIME_DIR`; reconstruct it from plain
files. Use progressive discovery so the model sees collection summaries before
requesting exact documents or skills. Optional Git synchronization should be
read-only by default, revision/checksum aware, capped, and explicit about local
changes.

Cloudflare's organization-wide public/admin libraries are not required. On one
laptop, the owner-curated collection is the correct trust root.

## 12. A connector platform, not a connector checklist

Cloudflare OS includes Gatekeepers for Cloudflare, Confluence, a context
library, email, GitHub, Google, Home Assistant, Linear, MCP, Notion, a scheduler,
Slack, Spotify, Supabase, and ZoomInfo. Their value is not the raw count. Typed,
service-specific connectors can express resource boundaries, observation
provenance, simulation, reversion, hooks, and collaborator verification more
safely than a generic token plus arbitrary HTTP.

Every Ghost connector should declare:

- supported resource URL/identifier patterns;
- account and OAuth scopes;
- typed read, write, and hook interfaces;
- observation and action classifications;
- simulation, idempotency, and revert behavior;
- sharing/observer verification behavior;
- limits and safe retry policy; and
- a local health and reconnect contract.

Prioritize by Ghost's local product:

1. local filesystem and Git, ghost-owned browser, owner browser tab, desktop,
   calendar, email, and Home Assistant;
2. GitHub plus the hardened MCP bridge;
3. Google, Slack, Notion, and Linear; and
4. optional enterprise/specialist integrations such as Confluence, Supabase,
   Cloudflare observability, Spotify, and ZoomInfo.

OAuth callbacks should use loopback, credentials remain in Secret Service, and
the connector process receives only the account material and resource scope it
needs. “Feature complete” means new connectors fit a secure platform; it does
not mean shipping every Cloudflare adapter.

## 13. Agent runtime, attachments, and web fetch

### Agent runtime lessons

Cloudflare's [agent.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent.ts)
uses Code Mode against a typed `env` of named capabilities. The app code
executor in [overseer.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/overseer.ts)
disables importable ambient environment and outbound network, while tailing
bounded logs. [agent-compaction.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/agent-compaction.ts)
keeps checkpoints and replay separate from model-context compaction.

Ghost should keep OMP as its agent engine, but add:

- named binding discovery and a small `describeBinding` surface;
- an isolated one-off code mode for composing calls across typed bindings;
- atomic run-step persistence, including proposed file/action effects;
- bounded, deterministic tool-result snapshots for transcript replay; and
- separate owner-facing rich data and model-facing bounded text.

This complements Bash and native project work; it does not replace them.

### Attachments

[chat-attachment-validation.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/chat-attachment-validation.ts)
normalizes MIME types, validates magic signatures, enforces limits, and accounts
for model-provider support. [chat-attachment-pdf.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/chat-attachment-pdf.ts)
bridges PDF handling where a provider supports it natively.

Ghost should use staged and committed attachment lifecycles, content digests,
MIME sniffing/signatures, per-file and per-message totals, provider capability
checks, draft cleanup, and explicit retention. Conversion should occur in a
sandboxed local parser/LibreOffice/Pandoc process; an owner can always open an
unsupported file in the normal desktop app.

### Web fetch

[web-fetch.ts](../../../tmp/cloudflare-os/packages/workshop-backend/src/web-fetch.ts)
is a useful model for an unauthenticated research fetch: HTTPS GET only, no
credentials/cookies, public-address enforcement, time and byte caps, content
signal handling, and bounded document-to-Markdown conversion.

Ghost should distinguish this audited fetch capability from either browser
mode. It should not silently borrow the owner's logged-in session. Apply the
same redirect/DNS protections as MCP, honor site AI-input policy where
available, and return provenance with the observation.

## 14. Activity, navigation, and operations

Cloudflare's Activity surface focuses on observations and action decisions,
whereas Grok Bot's tray is stronger for completed background and inter-agent
work. Ghost should combine them into one local inbox containing:

- pending/applied/rejected/failed actions;
- sensitive observations and connection requests;
- code/app proposals awaiting merge;
- delegated, callable, and routine results;
- schedule failures and unknown side-effect outcomes; and
- connector/keyring expiry and sandbox crashes.

The useful UI references are [Activity.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/Activity.tsx),
[ActivityNotifications.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/ActivityNotifications.tsx),
[Connections.tsx](../../../tmp/cloudflare-os/packages/workshop-frontend/src/Connections.tsx),
the [command palette](../../../tmp/cloudflare-os/packages/workshop-frontend/src/components/AppShell/CommandPalette.tsx),
and the global [Outputs route](../../../tmp/cloudflare-os/packages/workshop-frontend/src/routes/outputs.tsx).

Borrow operational discipline, too: connector readiness, credential expiry,
schema migrations, bounded stores, crash logs, immutable source revisions, safe
upgrade rollback, and a local doctor page. Use Ghost's package-manager-aware
updates rather than Cloudflare's hosted deployment, candidate release,
provisioning, quota, billing, and analytics systems.

## Mapping Cloudflare primitives onto Omarchy

| Cloudflare primitive | Ghost/Omarchy implementation |
| --- | --- |
| Durable Object workspace kernel | `ghostd` workspace service plus transactional SQLite/append log and plain source files |
| Dynamic Worker Facet | transient `systemd-run --user` service inside bubblewrap |
| Worker service bindings | opaque local capability handles over authenticated Unix sockets |
| `globalOutbound: null` | network namespace with no egress; brokered domain/resource access when granted |
| Worker SQLite storage | app-private XDG data directory, schema-versioned and backed up/exported separately |
| Sandboxed iframe | ghost-owned Chromium/PWA profile or carefully isolated Qt WebEngine surface |
| R2/Git object storage | ordinary Git worktrees/object database plus content-addressed local artifacts |
| Cloudflare Access identity | local OS owner, device keys, and scoped encrypted collaboration capabilities |
| OAuth Gatekeeper account | Secret Service credential plus a local connector process |
| Alarm-based schedule driver | systemd timer/path wake plus daemon-owned durable scheduler state |
| Cap'n Web capability RPC | small versioned local capability protocol; Cap'n Web optional where it fits |
| Hosted observability | redacted journald logs, local activity/audit store, and doctor diagnostics |

## What Ghost should deliberately not copy

- **Workers, Durable Objects, R2, KV, and Dynamic Worker deployment.** They solve
  Cloudflare's multi-tenant cloud operation, not Ghost's local ownership model.
- **Hosted sign-up, organizations, administrators, billing, AI Gateway credits,
  and daily quotas.** Provider policy and cost limits remain owner-local.
- **A React web shell as the primary desktop.** Keep the fast Quickshell HUD and
  use a sandboxed browser window only where arbitrary app UI requires it.
- **A public marketplace by default.** Local files and Git are enough until
  provenance, signing, review, sandboxing, and updates are mature.
- **Cloud storage as authority.** Workspaces, apps, memories, transcripts, and
  audit state should remain usable offline and backed up by the owner.
- **Workspace agents replacing ghosts.** A ghost's personality and memory must
  survive across workspaces; workspace access must not leak back into portable
  identity.
- **Ambient authority for generated apps.** Being local is not a reason to give
  model-authored code the owner's home directory, session bus, browser cookies,
  or network.
- **Cloudflare's current coarse sharing lockdown as the final design.** Retain
  the safety fallback but build per-observation and per-artifact flow labels.
- **Forever-online schedule assumptions.** Suspend, hibernate, offline periods,
  clock changes, and missed-run choices are first-class on a laptop.

## Where Ghost should exceed Cloudflare OS

Cloudflare OS is an excellent reference, but several open or cloud-shaped areas
are opportunities for Ghost:

- first-class scheduler run history, editing, pause/resume, explicit catch-up,
  and laptop sleep semantics;
- visible source in normal projects rather than an opaque server-side Git
  object store;
- recoverable Trash and owner-controlled backup/export for app data and audit;
- offline operation with no hosted identity or model gateway requirement;
- permanent multi-ghost collaboration with explicit persona provenance;
- richer local browser/desktop use, while keeping generated code behind a
  capability broker;
- per-artifact sharing restrictions rather than locking an entire workspace
  after one sensitive observation; and
- a production-supported local runtime rather than a development-only workerd
  path.

## Delivery roadmap

### Phase 0 — contracts and state model

- Specify Workspace, Run, Ghost App, Artifact, Binding, Observation, Action,
  Hook, and Blueprint in `CONTRACTS.md`.
- Define ownership, portability, deletion, export, recovery, and migration for
  each object.
- Unify these contracts with the capability broker, scheduler, inbox, and
  attachment objects proposed in the Grok report.
- Threat-model local code, stdio MCP, browser/desktop bridges, remote
  collaboration, and cross-ghost delegation.

Exit criterion: no feature below needs to invent a separate identity,
permission, action, or job state machine.

### Phase 1 — safety substrate

- Implement opaque named bindings and a machine-local capability policy store.
- Add observation/action persistence, approval cards, audit, and unknown-outcome
  handling.
- Build systemd/bubblewrap isolation with no network and filtered D-Bus by
  default.
- Route MCP through the central classifier, bounded catalog, sandbox, safe
  network broker, and at-most-once action store.
- Add transactional workspace drafts and Git/patch merge recovery.

Exit criterion: isolated code can read one granted resource and propose one
external write without ambient owner access or duplicate execution after a
crash.

### Phase 2 — local software factory

- Ship a minimal Ghost App manifest, local service runtime, browser UI sandbox,
  private app data, and typed RPC.
- Let a ghost create/edit an app inside a run draft and show a live proposed
  preview.
- Add accept, reject, three-way merge, archive, Trash, and crash recovery.
- Add the owner-wide Artifacts/Outputs view and bounded HTML/PDF/image export.

Exit criterion: a useful generated app survives restart and remains inspectable,
isolated, versioned, exportable, and removable.

### Phase 3 — resource platform

- Ship connection requests and a Connections manager.
- Implement local filesystem/Git, browser, calendar/email, GitHub, and Home
  Assistant bindings on the common Gatekeeper-shaped contract.
- Add connector-specific simulations/reverts and secure loopback OAuth.
- Expose bounded `describeBinding` and code-mode composition to OMP.

Exit criterion: an app can combine two exact resources without receiving either
account's credential or unrelated data.

### Phase 4 — durable and multi-ghost execution

- Complete the durable scheduler, hooks, retries, fencing, run history, budgets,
  and suspend/missed-run behavior.
- Add ephemeral runs, callable agents, and the asynchronous local ghost bus.
- Put routine, delegated, and approval-resumed results in the same activity
  inbox.
- Enforce per-run capability envelopes, delegation depth, fan-out, and cost
  limits.

Exit criterion: a scoped second ghost or scheduled callback can complete after
a daemon restart without authority expansion or duplicate side effects.

### Phase 5 — reuse and safe collaboration

- Add versioned Blueprint export/import with fresh data and binding setup.
- Add workspace/app/output roles over the encrypted collaboration channel.
- Track observation provenance and verify/redact/block resource data for every
  recipient.
- Add optional artifact OT and presence.

Exit criterion: another person can use an app and another laptop can instantiate
its Blueprint without receiving the owner's ghost memory, data, credentials,
grants, or enabled hooks.

### Phase 6 — context and ecosystem polish

- Add owner-curated context collections, progressive discovery, and optional
  bounded Git synchronization.
- Add more typed connectors based on demand.
- Complete the global palette, workspace/app/output navigation, diagnostics,
  migrations, and package-manager-aware update experience.

## End-to-end parity acceptance scenario

The following scenario is a more useful release gate than matching menu items:

1. The owner selects a permanent ghost and creates a workspace from a prompt or
   Blueprint.
2. The ghost creates a full-stack Ghost App. Its source is visible in normal
   files; its service and UI run without owner filesystem or network access.
3. The app requests a binding to one local repository and one exact GitHub
   repository. The owner sees the reason and grants only those resources.
4. Reads appear as observations with provenance. A local edit appears in the
   run draft; a GitHub mutation appears as a simulated/staged action.
5. The ghost continues against the simulated state and produces an output. The
   owner reviews code diffs, bindings, actions, and output together, approving
   one action and rejecting another.
6. The accepted local files merge atomically. The approved remote action is
   claimed once; a forced daemon restart cannot duplicate it and reports an
   honest unknown outcome if completion cannot be proven.
7. The app registers a disabled scheduled callback. The owner enables it with a
   narrow background capability set and explicit time-zone/missed-run policy.
8. A second permanent ghost receives a callable subtask with only one artifact
   and one read binding. Its transcript and result are attributed and visible;
   it cannot access the first ghost's memory or other workspace bindings.
9. The owner exports the output as PDF/HTML and shares a use-only app projection
   over encrypted collaboration. No remote user receives local filesystem,
   browser, model-account, or keyring access; external observations are verified
   or redacted.
10. The owner exports a Blueprint. Import on a clean machine reproduces source
    and requirements but starts with empty data, disabled hooks, and no grants.

When this works, Ghost has the important capabilities of Cloudflare OS while
remaining a genuinely local, multi-ghost Omarchy system rather than a
self-hosted copy of a cloud product.
