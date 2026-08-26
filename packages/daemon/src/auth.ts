/**
 * Provider login orchestration — signing a ghost into a model provider from
 * the shell instead of a terminal.
 *
 * OMP already owns the hard part. `GhostOmpRuntime.login(providerId, type,
 * interaction)` drives each provider's OAuth or API-key flow and persists the
 * result to the ghost's own `<home>/.pi/agent.db`. What OMP assumes is a TTY: an
 * `AuthInteraction` whose `prompt()` blocks for a typed answer and whose
 * `notify()` prints a URL or a device code. This module is the wrap that turns
 * that interactive, multi-step flow into a small pollable HTTP state machine so
 * the same `login()` can be driven over loopback by the Quickshell HUD.
 *
 * ## The shape of a login
 *
 * A login is short-lived and stateful. `start()` kicks off `login()` in the
 * background and returns a `loginId`; the caller then polls `view()` for the
 * current step to render, and satisfies any prompt with `submitInput()`. The
 * pi callbacks are bridged like so:
 *
 *   notify(auth_url)     → view.authUrl        (open it, or copy it)
 *   notify(device_code)  → view.deviceCode + verificationUrl
 *   notify(progress|info)→ view.message
 *   prompt(secret|text)  → view.prompt, status awaiting_input; resolved by submitInput
 *   prompt(manual_code)  → view.prompt (raced against OMP's callback server)
 *   prompt(select)       → view.prompt.options, status awaiting_select
 *
 * A callback-server flow (openai-codex, openrouter, anthropic) notifies an
 * `auth_url` AND issues a `manual_code` prompt at the same time: the view
 * therefore carries both, so the shell can show the URL to open and a paste
 * field as the headless fallback, and whichever completes first wins (pi
 * aborts the losing prompt through `AuthPrompt.signal`).
 *
 * ## Secrets
 *
 * A pasted code or api key flows straight from `submitInput()` into the
 * `prompt()` promise OMP is awaiting; it is NEVER stored on the view, returned
 * from a GET, or written to a log. Tokens land in exactly one place — OMP's
 * `agent.db`, written by `AuthStorage`. Device codes and auth URLs are not
 * secrets (they are meant to be shown), but are not logged either.
 *
 * The runtime is injected (`createRuntime`) so tests drive a fake `login()`
 * through every callback path without touching a real provider.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { GhostError, ghostPaths, type Ghost, type GhostRegistry } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  resolveOmpChatModel,
  setChatModelRoleIfUnset,
} from "./models.js";
import { createGhostOmpRuntime } from "./omp-runtime.js";

export type AuthType = "oauth" | "api_key";
export type Credential =
  | { type: "api_key"; key: string; source?: "login" }
  | {
      type: "oauth";
      refresh: string;
      access: string;
      expires: number;
      [key: string]: unknown;
    };
export type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { type: "info"; message: string; links?: Array<{ label?: string; url: string }> }
  | { type: "progress"; message: string };
export type AuthPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
      signal?: AbortSignal;
    }
  | {
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
      signal?: AbortSignal;
    };
export interface AuthInteraction {
  signal?: AbortSignal;
  notify(event: AuthEvent): void;
  prompt(prompt: AuthPrompt): Promise<string>;
}

/**
 * The minimum of `GhostOmpRuntime` this module drives; tests pass a fake with
 * a scripted `login()`.
 */
export interface LoginRuntime {
  getProviders(): readonly {
    id: string;
    name: string;
    auth: {
      oauth?: { isSubscription?: boolean; loginLabel?: string };
      apiKey?: { login?: unknown };
    };
  }[];
  getProviderAuthStatus(providerId: string): { configured: boolean };
  isUsingOAuth(providerId: string): boolean;
  getModels(providerId?: string): readonly Model<Api>[];
  getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  /** Release OMP's open SQLite/model-catalog handles once the flow settles. */
  close?(): void;
}

export type LoginStatus =
  | "starting"
  | "working"
  | "awaiting_url"
  | "awaiting_device_code"
  | "awaiting_input"
  | "awaiting_select"
  | "succeeded"
  | "failed";

/** A prompt to render. Never carries the value the user will enter. */
export interface LoginPromptView {
  kind: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  /** True when the answer is sensitive (api key / pasted code): mask the field. */
  secret: boolean;
  options?: { id: string; label: string; description?: string }[];
}

/** The full, safe-to-serialize state of a login. Holds no secret. */
export interface LoginView {
  loginId: string;
  providerId: string;
  authType: AuthType;
  status: LoginStatus;
  /** A progress/info line, when the flow last reported one. */
  message?: string;
  authUrl?: string;
  authInstructions?: string;
  deviceCode?: string;
  verificationUrl?: string;
  deviceExpiresInSeconds?: number;
  prompt?: LoginPromptView;
  /** Set on success when a chat model was bound because none was configured. */
  modelBound?: { provider: string; modelId: string };
  error?: string;
}

/** One provider a ghost can log into, derived from OMP's registry. */
export interface ProviderInfo {
  id: string;
  name: string;
  /** Whether this provider's OAuth is backed by a subscription (ChatGPT, Claude Pro). */
  subscription: boolean;
  /** The auth types offered, in the order oauth-then-key. */
  authTypes: AuthType[];
  /** OAuth selector label ("Sign in with OpenRouter"), when the provider sets one. */
  loginLabel?: string;
  /** Whether the ghost already has a working credential for this provider. */
  configured: boolean;
  /** Billing caveat safe to show in provider pickers. */
  billingNote?: string;
  /** How it is configured, when it is. */
  connectedVia?: AuthType;
}

interface PendingPrompt {
  isSelect: boolean;
  validIds?: Set<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface LoginSession {
  ghostName: string;
  /** Stable across the same-filesystem directory rename that changes a ghost's name. */
  ghostHome: GhostHomeIdentity;
  view: LoginView;
  controller: AbortController;
  runtime: LoginRuntime;
  runtimeClosed: boolean;
  pending: PendingPrompt | null;
  settledAt: number | null;
  /** TTL timer for an unfinished login; retention timer once settled. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface GhostHomeIdentity {
  device: bigint;
  inode: bigint;
}

interface StartingLogin {
  ghostName: string;
  ghostHome: GhostHomeIdentity;
  deleted: boolean;
  /** Settles after runtime construction has either become a LoginSession or failed. */
  finished: Promise<void>;
  finish: () => void;
}

function ghostHomeIdentity(dir: string): GhostHomeIdentity {
  const stats = statSync(dir, { bigint: true });
  return { device: stats.dev, inode: stats.ino };
}

function sameGhostHome(left: GhostHomeIdentity, right: GhostHomeIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function startingLogin(ghostName: string, ghostHome: GhostHomeIdentity): StartingLogin {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { ghostName, ghostHome, deleted: false, finished, finish };
}

export interface LoginManagerOptions {
  registry: GhostRegistry;
  logger?: Logger;
  /** Sets OMP's offline posture on the runtime it builds. See config.offline. */
  offline?: boolean;
  /** Abandon an unfinished login after this long. Default 5 min. */
  loginTtlMs?: number;
  /** Keep a settled login readable this long before dropping it. Default 60s. */
  retainSettledMs?: number;
  /** Test seam: build the per-ghost runtime a login drives. */
  createRuntime?: (input: { authPath: string; modelsPath: string; offline: boolean }) => Promise<LoginRuntime>;
  /** Awaited after credentials/model binding, before success becomes observable. */
  onLoginSucceeded?: (ghostName: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const DEFAULT_LOGIN_TTL_MS = 5 * 60_000;
const DEFAULT_RETAIN_SETTLED_MS = 60_000;
const CANCELLED_MESSAGE = "Login cancelled";
const AUTH_TYPES: readonly AuthType[] = ["oauth", "api_key"];
export const ANTHROPIC_EXTRA_USAGE_NOTE = "extra usage billed per token; not Claude plan limits";

async function defaultCreateRuntime(input: {
  authPath: string;
  modelsPath: string;
  offline: boolean;
}): Promise<LoginRuntime> {
  // allowModelNetwork is false either way: it gates only catalog refresh, not
  // the provider's own OAuth HTTP, so a login works offline. create() still
  // builds the local credential snapshot, which `configured`/`connectedVia`
  // read.
  return createGhostOmpRuntime({
    authPath: input.authPath,
    modelsPath: input.modelsPath,
    allowModelNetwork: false,
  });
}

/**
 * Bind `roles.chat_model` if the ghost has none, using OMP's provider-default
 * rule over the provider's available (then known) models. Provider-agnostic;
 * returns null and writes nothing when a model is already bound or none can be
 * resolved (offline, empty catalog). Shared by the HTTP login and the `ghostd
 * login` CLI so both leave a freshly-signed-in ghost ready to chat.
 */
export async function bindDefaultChatModelIfUnset(
  agentDir: string,
  runtime: Pick<LoginRuntime, "getAvailable" | "getModels">,
  providerId: string,
  options: {
    signal?: AbortSignal;
    /** Re-checked at the serialized models.json commit boundary. */
    commitAllowed?: () => boolean;
  } = {},
): Promise<{ provider: string; modelId: string } | null> {
  const commitAllowed = () => {
    if (options.signal?.aborted) return false;
    try {
      return options.commitAllowed?.() ?? true;
    } catch {
      return false;
    }
  };
  if (!commitAllowed()) return null;
  const existing = readGhostModels(agentDir);
  if (resolveChatModelRef(existing)) return null;

  const candidatesOrAborted = await discoverAvailableModels(
    runtime,
    providerId,
    options.signal,
  );
  if (candidatesOrAborted === null || !commitAllowed()) return null;
  let candidates = candidatesOrAborted;
  if (candidates.length === 0) candidates = runtime.getModels(providerId);
  const model = resolveOmpChatModel(null, candidates);
  if (!model || !commitAllowed()) return null;

  return setChatModelRoleIfUnset(agentDir, model.provider, model.id, commitAllowed);
}

async function discoverAvailableModels(
  runtime: Pick<LoginRuntime, "getAvailable">,
  providerId: string,
  signal?: AbortSignal,
): Promise<readonly Model<Api>[] | null> {
  if (signal?.aborted) return null;
  let discovery: Promise<readonly Model<Api>[]>;
  try {
    discovery = runtime.getAvailable(providerId);
  } catch {
    return [];
  }
  if (!signal) {
    try {
      return await discovery;
    } catch {
      return [];
    }
  }
  return new Promise((resolvePromise) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void discovery.then(
      (models) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(signal.aborted ? null : models);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(signal.aborted ? null : []);
      },
    );
  });
}

export class LoginManager {
  private readonly registry: GhostRegistry;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly loginTtlMs: number;
  private readonly retainSettledMs: number;
  private readonly createRuntime: NonNullable<LoginManagerOptions["createRuntime"]>;
  private readonly onLoginSucceeded: NonNullable<LoginManagerOptions["onLoginSucceeded"]>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, LoginSession>();
  /** Runtime construction has started, but no pollable login session exists yet. */
  private readonly starting = new Set<StartingLogin>();
  /** Whole-home moves admitted by the server but not yet completed or cancelled. */
  private readonly moving = new Set<GhostHomeIdentity>();
  private disposed = false;

  constructor(options: LoginManagerOptions) {
    this.registry = options.registry;
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.loginTtlMs = options.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.retainSettledMs = options.retainSettledMs ?? DEFAULT_RETAIN_SETTLED_MS;
    this.createRuntime = options.createRuntime ?? defaultCreateRuntime;
    this.onLoginSucceeded = options.onLoginSucceeded ?? (async () => {});
    this.now = options.now ?? Date.now;
  }

  private buildRuntime(ghostDir: string): Promise<LoginRuntime> {
    const paths = ghostPaths(ghostDir);
    return this.createRuntime({
      authPath: ghostAuthPath(paths.agentDir),
      modelsPath: ghostModelsPath(paths.agentDir),
      offline: this.offline,
    });
  }

  /** The providers this ghost can log into, derived from OMP's registry. */
  async listProviders(ghostName: string): Promise<ProviderInfo[]> {
    const ghost = this.registry.get(ghostName);
    const runtime = await this.buildRuntime(ghost.dir);
    try {
      return this.providersFrom(runtime);
    } finally {
      runtime.close?.();
    }
  }

  private providersFrom(runtime: LoginRuntime): ProviderInfo[] {
    const infos: ProviderInfo[] = [];
    for (const provider of runtime.getProviders()) {
      const authTypes: AuthType[] = [];
      if (provider.auth.oauth) authTypes.push("oauth");
      // An api-key provider without a `login` is ambient-only (env vars, AWS
      // profiles): there is nothing interactive to drive, so it is not a
      // provider an owner "logs into" from the HUD.
      if (provider.auth.apiKey?.login) authTypes.push("api_key");
      if (authTypes.length === 0) continue;
      const status = runtime.getProviderAuthStatus(provider.id);
      const info: ProviderInfo = {
        id: provider.id,
        name: provider.name,
        // pi marks Anthropic's OAuth mechanism as subscription auth, but its
        // pinned provider docs say third-party harness calls draw per-token
        // "extra usage", not included Claude plan limits. Do not label that
        // picker row as subscription; `claude-code/default` is the plan path.
        subscription: provider.id === "anthropic"
          ? false
          : provider.auth.oauth?.isSubscription ?? false,
        authTypes,
        configured: status.configured,
      };
      if (provider.id === "anthropic") {
        info.loginLabel = "Sign in (extra usage)";
        info.billingNote = ANTHROPIC_EXTRA_USAGE_NOTE;
      } else if (provider.auth.oauth?.loginLabel) {
        info.loginLabel = provider.auth.oauth.loginLabel;
      }
      if (status.configured) info.connectedVia = runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key";
      infos.push(info);
    }
    return infos.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Begin a login. Validates the provider/authType against OMP's registry,
   * then drives `runtime.login()` in the background. Returns the initial view.
   */
  async start(ghostName: string, providerId: string, authType: AuthType): Promise<LoginView> {
    if (this.disposed) {
      throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
    }
    this.sweep();
    const ghost = this.registry.get(ghostName);
    if (typeof providerId !== "string" || providerId === "") {
      throw new GhostError("invalid_request", '"providerId" is required.', 400);
    }
    if (!AUTH_TYPES.includes(authType)) {
      throw new GhostError("invalid_request", '"authType" must be "oauth" or "api_key".', 400);
    }
    const ghostHome = ghostHomeIdentity(ghost.dir);
    if ([...this.moving].some((movingHome) => sameGhostHome(movingHome, ghostHome))) {
      throw new GhostError(
        "ghost_busy",
        "Wait for this ghost's home move to finish before starting a login.",
        409,
      );
    }
    const starting = startingLogin(ghost.name, ghostHome);
    this.starting.add(starting);
    let runtime: LoginRuntime | undefined;
    let session: LoginSession | undefined;
    try {
      runtime = await this.buildRuntime(ghost.dir);
      if (this.disposed) {
        throw new GhostError("shutting_down", "The daemon is shutting down.", 503);
      }
      if (starting.deleted) {
        throw new GhostError("not_found", "This ghost was deleted while login was starting.", 404);
      }
      const offered = this.providersFrom(runtime).find((p) => p.id === providerId);
      if (!offered) {
        throw new GhostError(
          "unknown_provider",
          `No provider ${JSON.stringify(providerId)} to log into.`,
          400,
        );
      }
      if (!offered.authTypes.includes(authType)) {
        throw new GhostError(
          "unsupported_auth_type",
          `Provider ${JSON.stringify(providerId)} does not offer ${authType} login.`,
          400,
        );
      }

      const loginId = randomUUID();
      const controller = new AbortController();
      const ownedSession: LoginSession = {
        ghostName: starting.ghostName,
        ghostHome: starting.ghostHome,
        view: { loginId, providerId, authType, status: "starting" },
        controller,
        runtime,
        runtimeClosed: false,
        pending: null,
        settledAt: null,
        timer: null,
      };
      session = ownedSession;
      ownedSession.timer = setTimeout(() => this.abandon(loginId), this.loginTtlMs);
      // A daemon can restart between a session's turns; timers must not keep it
      // alive.
      ownedSession.timer.unref?.();
      this.sessions.set(loginId, ownedSession);

      const interaction: AuthInteraction = {
        signal: controller.signal,
        notify: (event) => this.onNotify(ownedSession, event),
        prompt: (prompt) => this.onPrompt(ownedSession, prompt),
      };
      // Reject the pending prompt if the whole flow is aborted (timeout/dispose).
      controller.signal.addEventListener(
        "abort",
        () => ownedSession.pending?.reject(new Error(CANCELLED_MESSAGE)),
        { once: true },
      );

      void runtime
        .login(providerId, authType, interaction)
        .then((credential) => this.onSuccess(ownedSession, credential))
        .catch((error: unknown) => this.onFailure(ownedSession, error));

      this.logger.info("ghost login started", {
        ghost: ownedSession.ghostName,
        provider: providerId,
        authType,
      });
      return this.publicView(ownedSession);
    } finally {
      this.starting.delete(starting);
      // Once a LoginSession exists it owns the runtime through settlement.
      if (!session) runtime?.close?.();
      starting.finish();
    }
  }

  /** The current step to show, or a structured 404 for an unknown login. */
  view(ghostName: string, loginId: string): LoginView {
    const session = this.sessionForGhost(ghostName, loginId);
    return this.publicView(session);
  }

  /** Satisfy an awaiting prompt with a pasted code, api key, or selected id. */
  submitInput(ghostName: string, loginId: string, value: string): LoginView {
    const session = this.sessionForGhost(ghostName, loginId);
    if (session.view.status === "succeeded" || session.view.status === "failed") {
      throw new GhostError("login_settled", `This login has already ${session.view.status}.`, 409);
    }
    const pending = session.pending;
    if (!pending) {
      throw new GhostError("no_pending_prompt", "This login is not awaiting input.", 409);
    }
    if (typeof value !== "string") {
      throw new GhostError("invalid_request", '"value" must be a string.', 400);
    }
    if (pending.isSelect && !pending.validIds?.has(value)) {
      throw new GhostError("invalid_option", "That is not one of the offered options.", 400);
    }
    pending.resolve(value);
    return this.publicView(session);
  }

  // ---- Interaction bridge ------------------------------------------------

  private onNotify(session: LoginSession, event: AuthEvent): void {
    if (this.isSettled(session)) return;
    switch (event.type) {
      case "auth_url":
        session.view.authUrl = event.url;
        if (event.instructions) session.view.authInstructions = event.instructions;
        break;
      case "device_code":
        session.view.deviceCode = event.userCode;
        session.view.verificationUrl = event.verificationUri;
        if (event.expiresInSeconds !== undefined) {
          session.view.deviceExpiresInSeconds = event.expiresInSeconds;
        }
        break;
      case "info":
      case "progress":
        session.view.message = event.message;
        break;
    }
    this.recomputeStatus(session);
  }

  private onPrompt(session: LoginSession, prompt: AuthPrompt): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.isSettled(session)) {
        reject(new Error(CANCELLED_MESSAGE));
        return;
      }
      const view: LoginPromptView = {
        kind: prompt.type,
        message: prompt.message,
        secret: prompt.type === "secret" || prompt.type === "manual_code",
      };
      if (prompt.type === "select") {
        view.options = prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }));
      } else if (prompt.placeholder) {
        view.placeholder = prompt.placeholder;
      }
      session.view.prompt = view;

      const promptSignal = prompt.signal;
      const clear = () => {
        if (session.pending === pending) {
          session.pending = null;
          session.view.prompt = undefined;
          this.recomputeStatus(session);
        }
        if (promptSignal && onPromptAbort) promptSignal.removeEventListener("abort", onPromptAbort);
      };
      const pending: PendingPrompt = {
        isSelect: prompt.type === "select",
        ...(prompt.type === "select"
          ? { validIds: new Set(prompt.options.map((option) => option.id)) }
          : {}),
        resolve: (value) => {
          clear();
          resolve(value);
        },
        reject: (error) => {
          clear();
          reject(error);
        },
      };
      // A callback-server flow races this prompt against its own redirect
      // catcher; pi aborts the prompt via its signal when the callback wins.
      let onPromptAbort: (() => void) | undefined;
      if (promptSignal) {
        if (promptSignal.aborted) {
          reject(new Error(CANCELLED_MESSAGE));
          return;
        }
        onPromptAbort = () => pending.reject(new Error(CANCELLED_MESSAGE));
        promptSignal.addEventListener("abort", onPromptAbort, { once: true });
      }
      session.pending = pending;
      this.recomputeStatus(session);
    });
  }

  private recomputeStatus(session: LoginSession): void {
    const view = session.view;
    if (view.status === "succeeded" || view.status === "failed") return;
    if (session.pending) {
      view.status = session.pending.isSelect ? "awaiting_select" : "awaiting_input";
    } else if (view.deviceCode) {
      view.status = "awaiting_device_code";
    } else if (view.authUrl) {
      view.status = "awaiting_url";
    } else if (view.message) {
      view.status = "working";
    } else {
      view.status = "starting";
    }
  }

  private async onSuccess(session: LoginSession, _credential: Credential): Promise<void> {
    if (!this.isActive(session)) return;
    const ghost = this.currentGhost(session);
    if (!ghost) {
      session.pending = null;
      session.view.prompt = undefined;
      session.view.status = "failed";
      session.view.error = "The ghost was deleted before login finished.";
      this.settle(session);
      this.logger.warn("ghost login target was deleted", {
        ghost: session.ghostName,
        provider: session.view.providerId,
      });
      return;
    }
    session.ghostName = ghost.name;
    session.pending = null;
    session.view.prompt = undefined;
    session.view.status = "working";
    session.view.message = "Finishing sign-in.";
    // Best-effort: give a freshly-signed-in ghost a chat model so the owner
    // lands ready to talk. Never fatal to the login itself.
    try {
      await this.bindDefaultModel(session);
    } catch (error) {
      this.logger.warn("could not bind a default chat model after login", {
        ghost: session.ghostName,
        provider: session.view.providerId,
        error: (error as Error).message,
      });
    }
    if (!this.isActive(session)) return;
    const refreshedGhost = this.currentGhost(session);
    if (!refreshedGhost) {
      throw new GhostError(
        "ghost_not_found",
        "The ghost was deleted before login state could be refreshed.",
        404,
      );
    }
    session.ghostName = refreshedGhost.name;
    await this.awaitSuccessHook(session, refreshedGhost.name);
    // Deletion/disposal can cancel the flow while the best-effort binding is
    // awaiting its model lookup or cached-runtime refresh. Do not resurrect it.
    if (!this.isActive(session)) return;
    session.view.status = "succeeded";
    session.view.message = "Signed in.";
    this.settle(session);
    this.logger.info("ghost login succeeded", {
      ghost: session.ghostName,
      provider: session.view.providerId,
      authType: session.view.authType,
      boundModel: session.view.modelBound?.modelId ?? null,
    });
  }

  private onFailure(session: LoginSession, error: unknown): void {
    if (this.sessions.get(session.view.loginId) !== session) return;
    if (this.isSettled(session)) {
      // A late rejection after a timeout already settled the session.
      this.settle(session);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = message === CANCELLED_MESSAGE || session.controller.signal.aborted;
    session.pending = null;
    session.view.prompt = undefined;
    session.view.status = "failed";
    session.view.error = cancelled ? (session.view.error ?? "Login was cancelled.") : message;
    session.settledAt = this.now();
    this.settle(session);
    this.logger.warn("ghost login failed", {
      ghost: session.ghostName,
      provider: session.view.providerId,
      authType: session.view.authType,
      reason: cancelled ? "cancelled" : "error",
    });
  }

  private async bindDefaultModel(session: LoginSession): Promise<void> {
    const ghost = this.currentGhost(session);
    if (!ghost) return;
    session.ghostName = ghost.name;
    const targetDir = ghost.dir;
    const bound = await bindDefaultChatModelIfUnset(
      ghostPaths(targetDir).agentDir,
      session.runtime,
      session.view.providerId,
      {
        signal: session.controller.signal,
        commitAllowed: () => this.isActive(session)
          && this.currentGhost(session)?.dir === targetDir,
      },
    );
    if (bound && this.isActive(session)) session.view.modelBound = bound;
  }

  // ---- Lifecycle ---------------------------------------------------------

  private isActive(session: LoginSession): boolean {
    return this.sessions.get(session.view.loginId) === session
      && !this.isSettled(session)
      && !session.controller.signal.aborted;
  }

  private async awaitSuccessHook(session: LoginSession, ghostName: string): Promise<void> {
    const signal = session.controller.signal;
    if (signal.aborted) throw new Error(CANCELLED_MESSAGE);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(new Error(CANCELLED_MESSAGE));
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve()
        .then(() => this.onLoginSucceeded(ghostName, signal))
        .then(resolvePromise, rejectPromise)
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
    });
  }

  private isSettled(session: LoginSession): boolean {
    return session.view.status === "succeeded" || session.view.status === "failed";
  }

  private settle(session: LoginSession): void {
    session.settledAt ??= this.now();
    if (session.timer) clearTimeout(session.timer);
    this.closeRuntime(session);
    // Keep the terminal state readable for one more poll cycle, then drop it.
    session.timer = setTimeout(() => this.sessions.delete(session.view.loginId), this.retainSettledMs);
    session.timer.unref?.();
  }

  private abandon(loginId: string): void {
    const session = this.sessions.get(loginId);
    if (!session || this.isSettled(session)) return;
    // Self-contained rather than routed through onFailure: the login() promise
    // may ignore the abort and never reject, and an abandoned login must still
    // reach a terminal, retained-then-dropped state.
    session.view.status = "failed";
    session.view.error = "Login timed out.";
    session.view.prompt = undefined;
    session.pending?.reject(new Error(CANCELLED_MESSAGE));
    session.pending = null;
    session.settledAt = this.now();
    this.settle(session);
    // Cancel the underlying flow (and its callback server, if any).
    if (!session.controller.signal.aborted) session.controller.abort();
    this.logger.warn("ghost login abandoned", {
      ghost: session.ghostName,
      provider: session.view.providerId,
    });
  }

  /** Drop settled sessions past their retention window. Cheap; called on start. */
  private sweep(): void {
    const cutoff = this.now() - this.retainSettledMs;
    for (const [loginId, session] of this.sessions) {
      if (session.settledAt !== null && session.settledAt <= cutoff) {
        if (session.timer) clearTimeout(session.timer);
        this.sessions.delete(loginId);
      }
    }
  }

  /** How many logins are currently tracked. Diagnostics/tests. */
  get size(): number {
    return this.sessions.size;
  }

  /** How many whole-home moves are currently gated. Diagnostics/tests. */
  get moveReservationCount(): number {
    return this.moving.size;
  }

  /**
   * Stop new login starts for one filesystem identity and wait until every
   * runtime construction already admitted for it has settled. The caller must
   * hold the returned reservation through `renameGhost`/`forgetGhost`, then
   * release it in a `finally` block if the home move fails.
   */
  async reserveGhostMove(ghostName: string): Promise<() => void> {
    const ghost = this.registry.get(ghostName);
    const ghostHome = ghostHomeIdentity(ghost.dir);
    if ([...this.moving].some((movingHome) => sameGhostHome(movingHome, ghostHome))) {
      throw new GhostError("ghost_busy", "Another whole-home move is already in progress.", 409);
    }

    this.moving.add(ghostHome);
    try {
      const admitted = [...this.starting]
        .filter((candidate) => sameGhostHome(candidate.ghostHome, ghostHome))
        .map((candidate) => candidate.finished);
      if (admitted.length > 0) await Promise.all(admitted);
    } catch (error) {
      this.moving.delete(ghostHome);
      throw error;
    }
    return () => {
      this.moving.delete(ghostHome);
    };
  }

  /**
   * Follow a successful home rename in diagnostics and deletion bookkeeping.
   * Filesystem identity is still authoritative: a newly-created ghost reusing
   * the old spelling must never inherit the earlier home's login.
   */
  renameGhost(renamed: Ghost): void {
    let renamedHome: GhostHomeIdentity;
    try {
      renamedHome = ghostHomeIdentity(renamed.dir);
    } catch {
      // The identity-based route lookup below is still authoritative. A
      // best-effort lifecycle notification must not turn a completed home move
      // into a failed HTTP response.
      return;
    }
    for (const starting of this.starting) {
      if (sameGhostHome(starting.ghostHome, renamedHome)) starting.ghostName = renamed.name;
    }
    for (const session of this.sessions.values()) {
      if (sameGhostHome(session.ghostHome, renamedHome)) session.ghostName = renamed.name;
    }
  }

  /** Abort and discard every login belonging to a home that just left the registry. */
  forgetGhost(ghostName: string): void {
    for (const starting of this.starting) {
      if (starting.ghostName === ghostName) starting.deleted = true;
    }
    for (const session of [...this.sessions.values()]) {
      if (session.ghostName !== ghostName) continue;
      session.view.status = "failed";
      session.view.error = "The ghost was deleted during login.";
      session.view.prompt = undefined;
      session.pending?.reject(new Error(CANCELLED_MESSAGE));
      session.pending = null;
      if (!session.controller.signal.aborted) session.controller.abort();
      if (session.timer) clearTimeout(session.timer);
      this.sessions.delete(session.view.loginId);
      this.closeRuntime(session);
    }
  }

  /** Abort every in-flight login and drop all state. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const starting of this.starting) starting.deleted = true;
    for (const session of this.sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
      if (!session.controller.signal.aborted) session.controller.abort();
      this.closeRuntime(session);
    }
    this.sessions.clear();
  }

  private sessionForGhost(ghostName: string, loginId: string): LoginSession {
    const ghost = this.registry.get(ghostName);
    const session = this.sessions.get(loginId);
    let matches = false;
    if (session) {
      try {
        matches = sameGhostHome(session.ghostHome, ghostHomeIdentity(ghost.dir));
      } catch {
        matches = false;
      }
    }
    if (!session || !matches) {
      throw new GhostError(
        "login_not_found",
        `No login ${JSON.stringify(loginId)} for this ghost.`,
        404,
      );
    }
    // A rename changes only the spelling/path. Remember the route's current
    // spelling for logs and for a later delete notification.
    session.ghostName = ghost.name;
    return session;
  }

  private currentGhost(session: LoginSession): Ghost | null {
    let ghosts: Ghost[];
    try {
      ghosts = this.registry.list();
    } catch {
      return null;
    }
    for (const ghost of ghosts) {
      try {
        if (sameGhostHome(session.ghostHome, ghostHomeIdentity(ghost.dir))) return ghost;
      } catch {
        // The directory moved between list() and stat(); another poll can retry.
      }
    }
    return null;
  }

  private closeRuntime(session: LoginSession): void {
    if (session.runtimeClosed) return;
    session.runtimeClosed = true;
    try {
      session.runtime.close?.();
    } catch (error) {
      this.logger.warn("could not close ghost login runtime", {
        ghost: session.ghostName,
        provider: session.view.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publicView(session: LoginSession): LoginView {
    // A copy, so a later mutation of the live view can never surprise a caller
    // mid-serialization.
    return { ...session.view, ...(session.view.prompt ? { prompt: { ...session.view.prompt } } : {}) };
  }
}
