/**
 * Provider login orchestration — signing a ghost into a model provider from
 * the shell instead of a terminal.
 *
 * pi already owns the hard part. `ModelRuntime.login(providerId, type,
 * interaction)` drives every provider's OAuth or api-key flow and persists the
 * result to the ghost's own `<home>/.pi/auth.json` (the same file
 * `session-host.ts`/`models.ts` read). What pi assumes is a TTY: an
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
 *   prompt(manual_code)  → view.prompt (raced against pi's own callback server)
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
 * `prompt()` promise pi is awaiting; it is NEVER stored on the view, returned
 * from a GET, or written to a log. Tokens land in exactly one place — pi's
 * `auth.json`, written by `login()` itself. Device codes and auth URLs are not
 * secrets (they are meant to be shown), but are not logged either.
 *
 * The runtime is injected (`createRuntime`) so tests drive a fake `login()`
 * through every callback path without touching a real provider.
 */
import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Credential,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { GhostError, ghostPaths, type GhostRegistry } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import {
  ghostAuthPath,
  ghostModelsPath,
  readGhostModels,
  resolveChatModelRef,
  writeGhostModels,
  type GhostModelsFile,
} from "./models.js";

/**
 * The minimum of `ModelRuntime` this module drives. `ModelRuntime` satisfies
 * it structurally; a test passes a fake with a scripted `login()`.
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
  getModels(providerId?: string): readonly { id: string }[];
  getAvailable(providerId?: string): Promise<readonly { id: string }[]>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
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

/** One provider a ghost can log into, derived from pi's registry. */
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
  view: LoginView;
  controller: AbortController;
  runtime: LoginRuntime;
  pending: PendingPrompt | null;
  settledAt: number | null;
  /** TTL timer for an unfinished login; retention timer once settled. */
  timer: ReturnType<typeof setTimeout> | null;
}

export interface LoginManagerOptions {
  registry: GhostRegistry;
  logger?: Logger;
  /** Sets pi's offline posture on the runtime it builds. See config.offline. */
  offline?: boolean;
  /** Abandon an unfinished login after this long. Default 5 min. */
  loginTtlMs?: number;
  /** Keep a settled login readable this long before dropping it. Default 60s. */
  retainSettledMs?: number;
  /** Test seam: build the per-ghost runtime a login drives. */
  createRuntime?: (input: { authPath: string; modelsPath: string; offline: boolean }) => Promise<LoginRuntime>;
  now?: () => number;
}

const DEFAULT_LOGIN_TTL_MS = 5 * 60_000;
const DEFAULT_RETAIN_SETTLED_MS = 60_000;
const CANCELLED_MESSAGE = "Login cancelled";
const AUTH_TYPES: readonly AuthType[] = ["oauth", "api_key"];
export const ANTHROPIC_EXTRA_USAGE_NOTE = "extra usage billed per token; not Claude plan limits";

/**
 * Curated fallback, used ONLY if pi's registry comes back empty (it never
 * should). The real list is derived from `runtime.getProviders()`.
 */
const FALLBACK_PROVIDERS: readonly ProviderInfo[] = [
  { id: "openai-codex", name: "OpenAI Codex", subscription: true, authTypes: ["oauth"], configured: false },
  {
    id: "anthropic",
    name: "Anthropic",
    subscription: false,
    authTypes: ["oauth", "api_key"],
    loginLabel: "Sign in (extra usage)",
    billingNote: ANTHROPIC_EXTRA_USAGE_NOTE,
    configured: false,
  },
  { id: "openrouter", name: "OpenRouter", subscription: false, authTypes: ["oauth", "api_key"], configured: false },
];

async function defaultCreateRuntime(input: {
  authPath: string;
  modelsPath: string;
  offline: boolean;
}): Promise<LoginRuntime> {
  // allowModelNetwork is false either way: it gates only catalog refresh, not
  // the provider's own OAuth HTTP, so a login works offline. create() still
  // builds the local credential snapshot, which `configured`/`connectedVia`
  // read.
  return ModelRuntime.create({
    authPath: input.authPath,
    modelsPath: input.modelsPath,
    allowModelNetwork: false,
  });
}

/**
 * Bind `roles.chat_model` if the ghost has none, choosing the provider's first
 * available (then first known) model. Provider-agnostic; returns null and
 * writes nothing when a model is already bound or none can be resolved
 * (offline, empty catalog). Shared by the HTTP login and the `ghostd login`
 * CLI so both leave a freshly-signed-in ghost ready to chat.
 */
export async function bindDefaultChatModelIfUnset(
  agentDir: string,
  runtime: Pick<LoginRuntime, "getAvailable" | "getModels">,
  providerId: string,
): Promise<{ provider: string; modelId: string } | null> {
  const existing = readGhostModels(agentDir);
  if (resolveChatModelRef(existing)) return null;

  let modelId: string | undefined;
  try {
    modelId = (await runtime.getAvailable(providerId))[0]?.id;
  } catch {
    modelId = undefined;
  }
  if (!modelId) modelId = runtime.getModels(providerId)[0]?.id;
  if (!modelId) return null;

  const file: GhostModelsFile = existing ?? { providers: {} };
  file.roles = { ...(file.roles ?? {}), chat_model: { provider: providerId, modelId } };
  writeGhostModels(agentDir, file);
  return { provider: providerId, modelId };
}

export class LoginManager {
  private readonly registry: GhostRegistry;
  private readonly logger: Logger;
  private readonly offline: boolean;
  private readonly loginTtlMs: number;
  private readonly retainSettledMs: number;
  private readonly createRuntime: NonNullable<LoginManagerOptions["createRuntime"]>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, LoginSession>();
  private disposed = false;

  constructor(options: LoginManagerOptions) {
    this.registry = options.registry;
    this.logger = options.logger ?? silentLogger;
    this.offline = options.offline ?? false;
    this.loginTtlMs = options.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.retainSettledMs = options.retainSettledMs ?? DEFAULT_RETAIN_SETTLED_MS;
    this.createRuntime = options.createRuntime ?? defaultCreateRuntime;
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

  /** The providers this ghost can log into, derived from pi's registry. */
  async listProviders(ghostName: string): Promise<ProviderInfo[]> {
    const ghost = this.registry.get(ghostName);
    const runtime = await this.buildRuntime(ghost.dir);
    const infos = this.providersFrom(runtime);
    return infos.length > 0 ? infos : [...FALLBACK_PROVIDERS];
  }

  private providersFrom(runtime: LoginRuntime): ProviderInfo[] {
    const infos: ProviderInfo[] = [];
    for (const provider of runtime.getProviders()) {
      const authTypes: AuthType[] = [];
      if (provider.auth.oauth) authTypes.push("oauth");
      // An api-key provider without a `login` is ambient-only (env vars, AWS
      // profiles): there is nothing interactive to drive, so it is not a
      // provider a creator "logs into" from the HUD.
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
   * Begin a login. Validates the provider/authType against pi's registry,
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
    const runtime = await this.buildRuntime(ghost.dir);
    const offered = this.providersFrom(runtime).find((p) => p.id === providerId);
    if (!offered) {
      throw new GhostError("unknown_provider", `No provider ${JSON.stringify(providerId)} to log into.`, 400);
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
    const session: LoginSession = {
      ghostName: ghost.name,
      view: { loginId, providerId, authType, status: "starting" },
      controller,
      runtime,
      pending: null,
      settledAt: null,
      timer: null,
    };
    session.timer = setTimeout(() => this.abandon(loginId), this.loginTtlMs);
    // A daemon can restart between a session's turns; timers must not keep it
    // alive.
    session.timer.unref?.();
    this.sessions.set(loginId, session);

    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event) => this.onNotify(session, event),
      prompt: (prompt) => this.onPrompt(session, prompt),
    };
    // Reject the pending prompt if the whole flow is aborted (timeout/dispose).
    controller.signal.addEventListener(
      "abort",
      () => session.pending?.reject(new Error(CANCELLED_MESSAGE)),
      { once: true },
    );

    void runtime
      .login(providerId, authType, interaction)
      .then((credential) => this.onSuccess(session, credential))
      .catch((error: unknown) => this.onFailure(session, error));

    this.logger.info("ghost login started", { ghost: ghost.name, provider: providerId, authType });
    return this.publicView(session);
  }

  /** The current step to show, or a structured 404 for an unknown login. */
  view(ghostName: string, loginId: string): LoginView {
    this.registry.get(ghostName);
    const session = this.sessions.get(loginId);
    if (!session || session.ghostName !== ghostName) {
      throw new GhostError("login_not_found", `No login ${JSON.stringify(loginId)} for this ghost.`, 404);
    }
    return this.publicView(session);
  }

  /** Satisfy an awaiting prompt with a pasted code, api key, or selected id. */
  submitInput(ghostName: string, loginId: string, value: string): LoginView {
    this.registry.get(ghostName);
    const session = this.sessions.get(loginId);
    if (!session || session.ghostName !== ghostName) {
      throw new GhostError("login_not_found", `No login ${JSON.stringify(loginId)} for this ghost.`, 404);
    }
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
    if (this.isSettled(session)) return;
    session.pending = null;
    session.view.prompt = undefined;
    session.view.status = "succeeded";
    session.view.message = "Signed in.";
    // Best-effort: give a freshly-signed-in ghost a chat model so the creator
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
    this.settle(session);
    this.logger.info("ghost login succeeded", {
      ghost: session.ghostName,
      provider: session.view.providerId,
      authType: session.view.authType,
      boundModel: session.view.modelBound?.modelId ?? null,
    });
  }

  private onFailure(session: LoginSession, error: unknown): void {
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
    const ghost = this.registry.find(session.ghostName);
    if (!ghost) return;
    const bound = await bindDefaultChatModelIfUnset(
      ghostPaths(ghost.dir).agentDir,
      session.runtime,
      session.view.providerId,
    );
    if (bound) session.view.modelBound = bound;
  }

  // ---- Lifecycle ---------------------------------------------------------

  private isSettled(session: LoginSession): boolean {
    return session.view.status === "succeeded" || session.view.status === "failed";
  }

  private settle(session: LoginSession): void {
    session.settledAt ??= this.now();
    if (session.timer) clearTimeout(session.timer);
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

  /** Abort every in-flight login and drop all state. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
      if (!session.controller.signal.aborted) session.controller.abort();
    }
    this.sessions.clear();
  }

  private publicView(session: LoginSession): LoginView {
    // A copy, so a later mutation of the live view can never surprise a caller
    // mid-serialization.
    return { ...session.view, ...(session.view.prompt ? { prompt: { ...session.view.prompt } } : {}) };
  }
}
