# Grok Bot feature-gap analysis

Status: product and architecture recommendation

This document compares Ghost with the reconstructed Grok Bot codebase and identifies the features worth adapting to make Ghost feel feature-complete. It deliberately treats Ghost as a local-first Omarchy application, not as a smaller version of Grok's cloud service.

The Grok Bot links below point to the sibling checkout at `github.com/tmp/grok-bot-0.18-reconstructed`. They work in the current development workspace; they will not resolve in a standalone clone of Ghost unless that checkout is present. Grok Bot's own [README](../../../tmp/grok-bot-0.18-reconstructed/README.md) says the repository is an unofficial reconstruction, so its behavior and contracts are useful references, but its implementation should not be copied unquestioningly.

## Executive summary

Ghost already has the better foundation for its intended product: multiple independent local ghosts, plain-file ghost homes, broad OMP model routing and fallback, keyring-backed credentials, explicit trusted projects, native Omarchy integration, local browser and desktop tools, conversation branching, voice, queues, and encrypted collaboration.

Grok Bot is more complete as an operating system for a team of agents. Its strongest ideas are:

- a capability and approval system for sensitive tools;
- isolation and ownership checks around execution environments;
- durable scheduling, recovery, and background work;
- asynchronous agent-to-agent messaging, groups, and broadcasts;
- routines with triggers, run history, and failure reporting;
- an activity inbox for work that finishes outside the active conversation;
- attachment handling, structured cards, replies, and in-chat search;
- a global command palette and content search;
- end-user installation and authorization flows for MCP servers and skills;
- teach-by-demonstration; and
- lifecycle polish such as cloning, avatars, readiness checks, and update notices.

The highest-priority work is not more UI. Ghost first needs a local capability broker, an isolation boundary, and a durable scheduler. Those primitives make multi-ghost communication, routines, external connectors, and teach mode safe enough to expose.

## Current Ghost baseline

Ghost's existing direction is already local-first and intentionally different from Grok Bot:

- [PLAN.md](PLAN.md) positions Grok as validation for messenger-style agents, per-agent identity, and teaching while keeping Ghost private, local, and Linux-native.
- [README.md](../README.md) describes the current safety hold on tasks, subagents, and executable plugins until isolation is in place.
- [PLAN.md](PLAN.md) likewise leaves executable extensions disabled pending the isolation work and lists teach-by-demonstration and ghost-to-ghost communication as open work.
- [packages/shell/README.md](../packages/shell/README.md) distinguishes a ghost asking its owner a question from a tool approval, although the latter is not yet a first-class user flow.
- [CONTRACTS.md](../CONTRACTS.md) remains authoritative for Ghost behavior. Every proposed capability below should be specified there before its public interface is considered stable.

The most useful one-file inventory of Grok Bot's coordination features is [source/shared/rpc/coordinator.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/rpc/coordinator.ts). Its RPC surface covers direct messages, groups, workflows, subagents, asynchronous tasks, teaching, trays, channels, shared rooms, and automations. [source/shared/rpc/main.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/rpc/main.ts) provides a complementary inventory of app-level capabilities such as updates, time zones, auto-review, tool permissions, attachments, models, usage, secrets, and MCP management.

## Comparison at a glance

| Area | Ghost today | Grok Bot pattern | Recommendation |
| --- | --- | --- | --- |
| Agent identity | Strong local, plain-file ghost homes | Cloud agents with managed identity and lifecycle | Keep Ghost's model; add clone, archive, avatar, and notification controls |
| Models | Strong OMP routing and fallback | Provider/model selection | Keep Ghost's implementation |
| Permissions | Trust and allowlists exist, but approvals are not a complete product surface | `always`, `ask`, and `never`, scoped requests, auto-review, audit | Build a machine-local capability broker first |
| Isolation | Risky executable features remain disabled | Owned Docker runtime with readiness and lifecycle checks | Use systemd, bubblewrap, and D-Bus filtering; make Podman optional |
| Background work | Queue and transcript foundations | Multiple run lanes, wake rearming, spend guards | Add a durable per-ghost scheduler and recovery model |
| Multi-agent work | Multiple ghosts; ghost-to-ghost work is open | Async DMs, groups, fan-out, shared rooms | Add a persisted local message bus with strict loop and authority limits |
| Routines | Not yet a complete feature | Schedules, triggers, history, enable/disable | Back with systemd timers/path units and explicit sleep semantics |
| Async results | Tray and unread foundations | Tasks and activity trays | Build a unified local activity inbox |
| Chat artifacts | Conversation and branching are strong; attachment workflow is incomplete | Attachments, cards, replies, drafts, find | Add staged files, structured cards, secure secret requests, and reply references |
| Search | No persistent authoritative index by design | Global palette and SQLite-backed content index | Use bounded scanning or a disposable runtime index |
| MCP and skills | OMP and configuration foundations | Catalog, OAuth, tool toggles, instructions, publishing | Productize installation and authorization without a cloud marketplace dependency |
| Teaching | Planned | Recorded demonstration converted into agent instructions | Capture Wayland and accessibility events into a reviewable draft |
| Operations | Local daemon and Omarchy integration | Readiness, update, usage, onboarding flows | Add a doctor page and package-manager-aware update notices |

## 1. Capability broker and approval cards

### What Grok Bot demonstrates

Grok Bot models local tool access as an explicit policy decision rather than a generic confirmation dialog. The core policy vocabulary is `always`, `ask`, and `never`. Permission requests carry enough context to show the proposed action, and the surrounding machinery tracks request state, stale decisions, refusal, and policy changes. Auto-review and action-audit services sit alongside this flow.

Implementation references:

- [source/shared/local-tool-permission.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/local-tool-permission.ts) defines the shared permission types and policy vocabulary.
- [source/shared/local-tool-permission-machinery.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/local-tool-permission-machinery.ts) implements permission-state handling and decision mechanics.
- [source/host/extensions/local-tool-permission/local-tool-permission-controller.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/local-tool-permission/local-tool-permission-controller.ts) connects requests, decisions, and host execution.
- [source/host/extensions/auto-review/auto-review-service.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/auto-review/auto-review-service.ts) is a reference for reviewing proposed actions before execution.
- [source/host/extensions/action-audit/action-audit-service.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/action-audit/action-audit-service.ts) records action outcomes for later inspection.

### What Ghost should borrow

Ghost should expose capabilities as typed grants with a scope, duration, and reason. At minimum, policies should cover:

- filesystem read and write, scoped to exact roots;
- use of the owner's browser versus a ghost-owned browser profile;
- screen capture separately from keyboard and pointer injection;
- network access scoped to domains or connector identities;
- invocation of individual MCP servers and tools;
- access to a named credential reference without revealing its value;
- external sends, including email, chat, issue creation, and publishing; and
- background execution separately from interactive execution.

An approval card should show the ghost, tool, exact target, arguments after secret redaction, scope of the requested grant, expiration, and expected side effect. The owner should be able to allow once, allow for the current run, always allow within a narrow scope, or deny. Decisions that arrive after a request has expired must be rejected rather than applied to a later action.

All attempted sensitive actions should produce an audit record, including denied and failed actions. Audit records should identify the policy and approval that authorized the action, but must never contain secret values.

### Local-first adaptation

Permanent policy belongs to the machine and owner, not inside an exportable ghost home. A shared ghost definition may request capabilities, but importing it must not import grants. A receiving ghost never inherits the sending ghost's authority during delegation. Each recipient re-evaluates the work against its own grants, and any eventual external side effect is attributed to the ghost that performed it.

This is the prerequisite for re-enabling executable extensions, tasks, and subagents safely.

## 2. Isolation and owned execution environments

### What Grok Bot demonstrates

Grok Bot's local development path creates and validates an owned Docker environment, exposes a loopback control path, uses content-addressed artifacts, checks readiness, and refuses to attach to an environment it does not own. The useful lesson is lifecycle ownership and validation, not Docker itself.

Implementation references:

- [source/electron-main/box/local-docker-host-connector.ts](../../../tmp/grok-bot-0.18-reconstructed/source/electron-main/box/local-docker-host-connector.ts) contains the local runtime connector, ownership checks, readiness flow, and stop/replace lifecycle.
- [README.md](../../../tmp/grok-bot-0.18-reconstructed/README.md) documents the reconstructed local Docker workflow and its architectural role.

### What Ghost should borrow

Every non-trivial executable action should run under an identity owned by Ghost, with a manifest describing the ghost, run, granted capabilities, mounts, network policy, and expiry. Runtime startup should be validated before work begins, and stale or foreign runtimes should be refused. Stop, crash, timeout, and replacement should have explicit state transitions.

Inputs should be mounted read-only whenever possible. Staged attachments and generated artifacts should be addressed by digest so a later run cannot silently receive changed bytes under the same identifier.

### Local-first adaptation

The default Omarchy stack should be:

- a transient user service via `systemd-run --user` for lifetime, logs, limits, and cleanup;
- bubblewrap for filesystem and process isolation;
- `xdg-dbus-proxy` or an equivalent filtered bus for narrowly approved desktop services;
- explicit network namespaces or a broker for domain-scoped network access; and
- optional Podman for projects that need a full container image.

Ghost should not require Docker or a forever-running virtual machine. Direct host execution remains useful for explicitly approved interactive desktop actions, but it should be visible as the less-isolated execution class.

Do not copy Grok's broad credential-directory mounting patterns. Ghost should continue to pass opaque keyring references and tightly scoped configuration rather than mounting an owner's complete Claude, Codex, browser, SSH, or cloud credential directories.

## 3. Durable scheduler, recovery, and budgets

### What Grok Bot demonstrates

Grok Bot separates interactive owner work, agent-initiated work, and background automation into scheduler lanes. It re-arms pending work after a wake or restart and places time/spend guards around automation.

Implementation references:

- [source/host/extensions/transcript/run-scheduler.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/transcript/run-scheduler.ts) is the primary run-lane and scheduling reference.
- [source/host/extensions/transcript/pending-wake-rearm.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/transcript/pending-wake-rearm.ts) demonstrates recovery of pending wakeups.
- [source/host/extensions/transcript/automation-spend-guard-runtime.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/transcript/automation-spend-guard-runtime.ts) demonstrates runtime budget enforcement for automation.

### What Ghost should borrow

Ghost needs a durable run record with states such as queued, preparing, waiting for approval, running, waiting for another ghost, completed, failed, cancelled, and interrupted. It should provide:

- separate owner, delegated, and background lanes;
- owner-initiated work priority without starving background work forever;
- per-ghost serialization by default, with explicitly bounded concurrency where safe;
- watchdogs, cancellation, maximum runtime, token limits, and provider cost limits;
- idempotent wake and completion handling;
- restart recovery that distinguishes safe retry from actions whose side effects are uncertain; and
- diagnostics explaining why work is queued, blocked, or abandoned.

The scheduler should be built before exposing multi-ghost delegation or routines. Both features otherwise create work the user cannot reliably observe or control.

### Local-first adaptation

Persist only the minimal durable run state and references to transcripts/artifacts. Use the user service manager for lifecycle and wake integration, while keeping Ghost's daemon authoritative for run transitions. Treat suspend and hibernate as normal events: deadlines should use wall-clock semantics, and work that missed a wake must follow an explicit per-routine catch-up policy.

## 4. Asynchronous ghost-to-ghost messaging and groups

### What Grok Bot demonstrates

Grok Bot's agent messaging is asynchronous. A sender does not synchronously wait or poll another agent. Delivery creates a separate recipient turn, and the system has distinct concepts for direct messages, group conversations, fan-out, and shared rooms. This separation helps prevent recursive agent calls from becoming an invisible call stack.

Implementation references:

- [source/host/agents/agent-messaging.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/agents/agent-messaging.ts) contains core agent-addressing and messaging behavior.
- [source/host/extensions/transcript/agent-to-agent-messaging.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/transcript/agent-to-agent-messaging.ts) bridges transcript turns and inter-agent delivery.
- [source/host/extensions/transcript/group-chat-orchestrator.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/transcript/group-chat-orchestrator.ts) coordinates group participation.
- [source/host/extensions/transcript/shared-rooms.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/transcript/shared-rooms.ts) shows room-level behavior.
- [source/host/groups/group-chat.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/groups/group-chat.ts) and [source/host/groups/group-store.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/groups/group-store.ts) cover group messaging and persistence.

### What Ghost should borrow

Add a local message bus with persisted envelopes. Each envelope should include a stable delivery ID, sender and recipient identities, conversation or room ID, parent delivery ID, provenance, creation time, expiry, priority, and bounded payload/artifact references. Delivery and completion must be idempotent.

Support these modes in stages:

1. Direct message to one ghost.
2. Delegated task with a result returned asynchronously.
3. Owner-created group conversation.
4. Explicit broadcast or parallel fan-out.

Guardrails should cap delegation depth, cycle count, fan-out, total tokens, total time, and concurrent recipients. A ghost should not broadcast merely because it discovered a useful recipient; fan-out beyond the original target set needs owner policy or approval. Repeated ping-pong should be detected and stopped with a visible explanation.

The owner must be able to inspect every message and see which ghost authored which output. Group definitions, memberships, and delivery state belong to owner-wide machine state, not to a single portable ghost home.

### Local-first adaptation

Use a Unix-domain or loopback-only daemon protocol, not a hosted room backend. Online ghosts on the same laptop can receive immediately; offline ghosts receive when the local scheduler starts their turn. Optional encrypted human collaboration can continue using Ghost's existing collaboration layer, but it should remain separate from the local ghost bus so cloud-style identity and authority do not leak into local execution.

## 5. Routines and local automation

### What Grok Bot demonstrates

Grok Bot treats routines as product objects, not just cron strings. They can be enabled or disabled, run manually, show their next run, preserve run history, and react to both schedules and external event triggers.

Implementation references:

- [source/shared/automations.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/automations.ts) defines automation objects and shared contracts.
- [source/shared/automation-schedule.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/automation-schedule.ts) handles schedule representation and calculation.
- [source/host/automations/automation-store.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/automations/automation-store.ts) persists automation definitions and state.
- [source/host/automations/automation-trigger.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/automations/automation-trigger.ts) handles event-triggered runs.
- [frontend/src/recovered/features/automations/routines/controller.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/automations/routines/controller.ts) is a useful UI/controller reference.
- [frontend/src/recovered/features/automations/routines/schedule-editor.tsx](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/automations/routines/schedule-editor.tsx) demonstrates schedule editing.
- [frontend/src/recovered/features/automations/routines/run-history.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/automations/routines/run-history.ts) demonstrates routine history presentation.

### What Ghost should borrow

A Ghost routine should contain:

- an owning ghost and owner-visible name;
- a prompt or named skill entry point;
- a schedule or trigger and time zone;
- enabled state, next-run calculation, and manual-run support;
- concurrency and coalescing policy;
- missed-run policy;
- maximum runtime, token, and provider-cost budgets;
- capabilities granted specifically for background execution;
- success, failure, and notification policy; and
- immutable references to each run and its artifacts.

Start with schedules and local events: file changes, login, network availability, repository changes, and explicit local hooks. Add Slack, GitHub, Linear, Sentry, PagerDuty, email, and other SaaS triggers only through installed connectors with their own credentials and capability policies.

### Local-first adaptation

Use systemd user timers and path units as wake sources, with the Ghost daemon validating and starting the actual run. The UI must say whether the laptop must be awake and what happens after sleep: skip, run once on resume, or catch up each missed occurrence up to a bound. Time-zone changes and daylight-saving transitions need deterministic behavior.

A routine's interactive permissions must not automatically become background permissions. Background sends and desktop control should generally require a separately granted, narrower policy.

## 6. Unified activity inbox

### What Grok Bot demonstrates

Grok Bot separates asynchronous task state and tray activity from the currently open conversation. Completed work, failures, and messages therefore have somewhere durable to land.

Implementation references:

- [frontend/src/recovered/features/agent-info/async-tasks/provider.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/agent-info/async-tasks/provider.ts) models asynchronous tasks for the frontend.
- [source/host/extensions/trays/trays-service.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/trays/trays-service.ts) provides host-side tray behavior.

### What Ghost should borrow

Turn Ghost's existing tray and unread foundation into one activity inbox for:

- delegated tasks that completed or failed;
- routine outcomes and skipped runs;
- incoming ghost messages and group mentions;
- permission requests and expiring approvals;
- connector authorization or health problems;
- daemon recovery events; and
- files or drafts awaiting owner review.

Every item should have a type, severity, ghost, related conversation/run, created and resolved times, deduplication key, and one primary action. Items should remain inspectable after being marked read. Desktop notifications should be a projection of inbox policy rather than a separate source of truth.

The inbox is what makes background work legible on a laptop that may suspend, restart, or be offline.

## 7. Attachments, structured cards, replies, and secure requests

### What Grok Bot demonstrates

Grok Bot's conversation surface supports staged attachments, bounded media handling, persistent composer state, reply relationships, find-in-chat, and structured transcript cards. Its card protocol includes widgets, agent/task status, email and Slack drafts, auto-review, listener connection, secret requests, attachments, connectors, and local tool permissions.

Implementation references:

- [frontend/src/recovered/features/conversation/cards/transcript-card/protocol.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/cards/transcript-card/protocol.ts) is the central structured-card protocol reference.
- [frontend/src/recovered/features/conversation/workspace/model.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/model.ts) models conversation workspace state.
- [frontend/src/recovered/features/conversation/workspace/composer.tsx](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/composer.tsx) demonstrates attachment-aware composing and draft behavior.
- [frontend/src/recovered/features/conversation/workspace/find-in-chat.tsx](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/find-in-chat.tsx) demonstrates local conversation search.
- [frontend/src/recovered/features/conversation/workspace/reply-thread-controller.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/reply-thread-controller.ts) handles reply relationships.
- [source/shared/media/attachment-limits.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/media/attachment-limits.ts) centralizes attachment limits.
- [source/electron-main/attachments/attachment-manager.ts](../../../tmp/grok-bot-0.18-reconstructed/source/electron-main/attachments/attachment-manager.ts) stages and manages attachment data.

### What Ghost should borrow

Add paste, drag-and-drop, and file-picker attachments with explicit size and type limits. Stage immutable input bytes for the run, display a preview, and preserve source name and MIME metadata without treating an extension as authoritative. Large directories or project roots should remain capability-scoped references rather than being copied wholesale into a transcript.

Adopt a small versioned card protocol for:

- permission and auto-review requests;
- delegated task status;
- proposed external messages and drafts;
- connector login or repair;
- secret requests;
- routine status and next run; and
- generated files and artifact previews.

Unknown card versions must degrade to readable text. Cards should refer to host-owned actions by opaque ID; rendered transcript content must not be able to invoke arbitrary commands.

Secret requests deserve a dedicated flow. The owner enters a value into a trusted shell surface, it goes directly to Secret Service, and the transcript receives only a credential reference and display label. The value must not pass through the model or transcript.

Add reply references and find-in-conversation early. Reactions and thread-heavy group UX can wait until local groups exist. For complex office documents, use previews plus `xdg-open`; rebuilding an Electron-style office surface in Quickshell is not a good use of Ghost's local-native advantage.

## 8. Global palette and search

### What Grok Bot demonstrates

Grok Bot combines a command-palette model with a host-side content index. The result is fast navigation across agents and content, not merely text search inside the active chat.

Implementation references:

- [frontend/src/production/command-palette-model.ts](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/production/command-palette-model.ts) models global command and navigation results.
- [source/host/extensions/content-search/search-index-service.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/content-search/search-index-service.ts) implements indexing and search orchestration.
- [source/host/extensions/content-search/search-index-db.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/content-search/search-index-db.ts) shows the persistent database approach used by Grok Bot.

### What Ghost should borrow

One palette should find and act on ghosts, groups, conversations, messages, files, links, routines, connector actions, and settings. Results must expose their ghost and scope so two identically named artifacts are not confused.

### Local-first adaptation

Ghost's plan intentionally avoids stored indexes. Preserve that property by starting with bounded `rg`/filesystem scans for cold queries and an in-memory catalog for active metadata. If scale requires an index, make it disposable under `$XDG_RUNTIME_DIR/ghost`, rebuild it after login, and update it with filesystem watchers. Ghost homes and transcripts remain authoritative; deleting the index must lose no user data.

Search must obey capability and privacy boundaries. A ghost may search only the files and conversations available to it, while the owner-facing palette can search owner-wide metadata. Secret values are never indexed.

## 9. MCP and skill productization

### What Grok Bot demonstrates

Grok Bot wraps MCP in an end-user product flow: catalog discovery, installation, OAuth loopback, custom instructions, individual tool toggles, management, plugin-provided skills, and skill publishing.

Implementation references:

- [source/shared/node/mcp/mcp-marketplace.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/node/mcp/mcp-marketplace.ts) models catalog discovery and installable MCP entries.
- [source/shared/node/mcp/mcp-oauth-loopback.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/node/mcp/mcp-oauth-loopback.ts) implements a local OAuth callback flow.
- [source/shared/node/mcp/mcp-instructions-and-toggles.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/node/mcp/mcp-instructions-and-toggles.ts) handles instructions and per-tool enablement.
- [source/shared/node/mcp/mcp-manager.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/node/mcp/mcp-manager.ts) coordinates MCP lifecycle and configuration.
- [source/host/extensions/mcp/plugin-skills.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/mcp/plugin-skills.ts) connects plugins with skills.
- [source/host/extensions/mcp/skill-publish.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/mcp/skill-publish.ts) is a reference for publishing or synchronizing a skill.

### What Ghost should borrow

Create a local catalog/install flow that previews before mutation:

- source repository, revision, and checksum;
- files and commands to be installed;
- declared MCP servers and tools;
- requested network, filesystem, credential, and background capabilities;
- accounts or OAuth scopes involved; and
- the exact diff for updates.

Allow per-ghost enablement, per-tool toggles, custom instructions, update, disable, and uninstall. Store access and refresh tokens in Secret Service and configuration by credential reference. The loopback OAuth receiver should bind to loopback only, validate state and PKCE, have a short expiry, and close after one successful callback.

### Local-first adaptation

The catalog can initially be a curated manifest or Git repository rather than a hosted marketplace. Do not copy team popularity, cloud policy, or centralized entitlement systems. Installation must remain visible as ordinary Ghost files and configuration, and removing a connector should clearly report retained transcripts or artifacts.

## 10. Teach-by-demonstration

### What Grok Bot demonstrates

Grok Bot has a dedicated teach-recording service that treats recording as a bounded session with state and an eventual artifact, instead of indefinitely observing the desktop.

Implementation reference:

- [source/host/extensions/teach-recording/teach-recording-service.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/extensions/teach-recording/teach-recording-service.ts) contains the recording-session service and lifecycle.

### What Ghost should borrow

Teach mode should record a demonstration and produce a draft skill or routine. It should combine:

- Wayland-approved screen or window capture;
- AT-SPI semantic accessibility events where available;
- application/window identity and geometry;
- approved keyboard and pointer events only as a fallback; and
- optional owner narration.

Recording must be unmistakably visible, time-bounded, pausable, and cancellable. Password fields, Secret Service prompts, private applications, and owner-defined screen regions must be masked or automatically pause recording. Raw recordings should have an explicit retention policy.

The result should be a reviewable draft containing steps, selectors, assumptions, required capabilities, inputs, outputs, and test criteria. The owner edits and tests it before installation. A demonstration must never silently activate a new background routine or grant capabilities.

### Local-first adaptation

Prefer semantic accessibility selectors over absolute screen coordinates so demonstrations survive layout changes. Package the output in Ghost's normal skill format and use the same capability preview as any externally installed skill. Local recording and conversion should remain useful without a Grok-style cloud box or remote desktop.

## 11. Lifecycle and operational polish

### What Grok Bot demonstrates

Grok Bot includes agent cloning, avatar management, onboarding/readiness flows, usage summaries, and a self-update service.

Implementation references:

- [source/host/agents/agent-clone.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/agents/agent-clone.ts) implements agent duplication behavior.
- [source/host/agents/agent-avatar.ts](../../../tmp/grok-bot-0.18-reconstructed/source/host/agents/agent-avatar.ts) handles agent avatar state.
- [frontend/src/recovered/features/onboarding/signed-in/view.tsx](../../../tmp/grok-bot-0.18-reconstructed/frontend/src/recovered/features/onboarding/signed-in/view.tsx) is a reference for readiness and onboarding presentation.
- [source/shared/usage.ts](../../../tmp/grok-bot-0.18-reconstructed/source/shared/usage.ts) defines usage summaries.
- [source/electron-main/update/sand-update-service.ts](../../../tmp/grok-bot-0.18-reconstructed/source/electron-main/update/sand-update-service.ts) demonstrates application update state and UX.

### What Ghost should borrow

Add these lower-risk product features after the execution foundation:

- duplicate a ghost with explicit choices for persona/configuration, skills, routines, and memory, while excluding sessions and history by default;
- avatar selection and predictable generated fallback;
- hide/archive without deleting the ghost home;
- pinned ghosts/groups and per-ghost notification controls;
- kickoff templates for common local roles;
- a doctor/readiness page for the daemon, desktop helper, browser profile, Secret Service, model credentials, permissions, and optional isolation tools;
- a local usage view based on tokens, runtime, and provider-reported cost where available; and
- package-manager-aware update availability.

Usage reporting should be local, optional, and export-free by default. It does not need Grok's monetization concepts. Update UX should respect AUR/pacman ownership: show the installed and available version and invoke or explain the supported package-manager path rather than installing an opaque self-update over managed files.

A one-shot dictation action would also fit Ghost well, using the existing voice foundation without requiring a full always-listening assistant.

## What not to borrow

These Grok Bot characteristics conflict with Ghost's product boundary or duplicate stronger Ghost foundations:

- A remote, always-on cloud box or VNC-style desktop.
- Cloud agent storage as the authoritative home for identity, memory, or files.
- Hosted cross-user identity, rooms, and presence for local ghost coordination.
- Cloud synchronization as a default for ghost homes.
- Mobile push as a dependency for approvals or background completion.
- General egress tunnels that bypass the local network capability broker.
- Shared credential-directory mounts or centralized cloud credential custody.
- Electron as the shell when Quickshell provides native Omarchy integration.
- A self-updater that bypasses pacman/AUR package ownership.
- Product telemetry, experimentation, and hosted error reporting such as Statsig or Sentry by default.
- Team-admin, popularity, entitlement, and marketplace-ranking systems.
- Grok-specific provider/model architecture where OMP already gives Ghost broader local routing and fallback.

Ghost's encrypted collaboration remains the right optional path for a remote human participant. Hosted multi-user agent rooms can be reconsidered later, but they are not required for feature completeness on one Omarchy laptop.

## Local-first architecture rules

The adaptations above should follow a few consistent rules:

1. Ghost homes are portable identity and behavior, not portable authority.
2. Machine policy, approvals, credentials, group membership, scheduler state, and audit records remain owner-local.
3. Every background or delegated action has a durable run ID and a visible terminal state.
4. Every sensitive side effect is authorized at the performing ghost, not inherited through a chain.
5. Transcripts and plain files are authoritative; indexes and derived previews are disposable.
6. Secrets move from trusted UI to Secret Service and tools by opaque reference, never through model text.
7. systemd and Wayland-native mechanisms are the default integration points; containers and cloud connectors are optional layers.
8. Laptop suspend, offline periods, daemon restarts, and package-managed updates are normal operating conditions.
9. Imported skills, ghosts, and connector manifests are data until the owner reviews their requested capabilities.

## Recommended delivery order

### Phase 1: safe execution foundation

1. Define capability, approval, audit, run, and artifact contracts in `CONTRACTS.md`.
2. Implement the machine-local capability broker and structured approval cards.
3. Add the systemd/bubblewrap execution runner, ownership/readiness validation, and optional Podman adapter.
4. Re-enable executable extensions only through that boundary.

### Phase 2: durable work

1. Implement scheduler lanes, per-ghost serialization, budgets, cancellation, and recovery.
2. Build the unified activity inbox and diagnostics.
3. Make daemon restart and laptop resume part of the normal integration test matrix.

### Phase 3: multiple ghosts working together

1. Add local asynchronous direct messages and delegated task results.
2. Add groups and explicit broadcasts with cycle, fan-out, depth, time, and token limits.
3. Expose complete provenance and per-recipient capability evaluation.

### Phase 4: routines and richer work products

1. Add schedules, local event triggers, history, manual run, and missed-run policy.
2. Add attachments, immutable artifacts, structured cards, secure secret requests, replies, and find-in-chat.
3. Add the global palette and disposable search index if scanning is no longer sufficient.

### Phase 5: ecosystem and teaching

1. Productize MCP/skill installation, loopback OAuth, updates, and per-tool controls.
2. Add teach-by-demonstration as a draft-producing, review-required workflow.
3. Finish cloning, archive/hide, avatars, readiness, usage, and package-manager update polish.

## Feature-complete acceptance scenario

Ghost is feature-complete for the local multi-agent promise when one owner can complete this scenario without a terminal:

1. Create or clone two ghosts and understand what was copied.
2. Grant each ghost different bounded filesystem, browser, network, and connector capabilities.
3. Attach a document to one ghost and schedule a recurring local routine around it.
4. Have that ghost delegate a bounded subtask to the other ghost asynchronously.
5. Review and approve one sensitive action with the exact target and scope visible.
6. Suspend or restart the laptop while work is pending, then recover without duplicate side effects.
7. Receive the result, failure, or skipped-run explanation in the activity inbox.
8. Search for the originating conversation, delegated message, generated file, and routine run.
9. Inspect an audit trail that explains which ghost performed each action under which grant.
10. Export either ghost without exporting credentials, machine grants, other ghosts' messages, or owner-wide scheduler state.

Passing this scenario would give Ghost the practical completeness of Grok Bot's agent teamwork while preserving the reasons Ghost exists: local ownership, Omarchy-native interaction, inspectable files, and no required cloud control plane.
