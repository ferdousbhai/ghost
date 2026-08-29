import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { GhostError } from "./ghosts.js";

export interface CollaborationParticipant {
  name: string;
  role: "host" | "guest";
  readOnly?: boolean;
}

export interface CollaborationStatus {
  supported: true;
  active: boolean;
  readOnlyUrl?: string;
  writableUrl?: string;
  participants: CollaborationParticipant[];
}

export interface StartCollaborationInput {
  sessionKey: string;
  session: AgentSession;
  /** Routes a guest's prompt through the host's owner-pass bookkeeping. */
  promptGuest?: (text: string) => Promise<void>;
  relayUrl: string;
  writable: boolean;
  confirmed: boolean;
  /** The web UI base for share links, from the ghost's settings. */
  webUrl?: string;
}

export interface CollaborationHost {
  readonly link: string;
  readonly webLink: string;
  readonly viewLink: string;
  readonly webViewLink: string;
  readonly participants: CollaborationParticipant[];
  start(relayUrl: string, webUrl?: string): Promise<void>;
  stop(reason: string): Promise<void>;
}

/** What a relay host is built from: the session it mirrors and how guests prompt it. */
export interface CollaborationHostContext {
  session: AgentSession;
  promptGuest: (text: string) => Promise<void>;
  contextUsage(): { usedTokens: number; contextWindow: number };
}

export type CollaborationHostFactory = (context: CollaborationHostContext) => CollaborationHost;

interface ActiveCollaboration {
  host: CollaborationHost;
  writable: boolean;
}

export interface CollaborationManagerOptions {
  createHost?: CollaborationHostFactory;
}

function normalizedRelayUrl(value: string): string {
  const source = value.trim();
  if (!source) {
    throw new GhostError(
      "invalid_request",
      "A collaboration relay URL is required.",
      400,
    );
  }
  const withScheme = source.includes("://") ? source : `wss://${source}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new GhostError("invalid_request", "The collaboration relay URL is invalid.", 400);
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) {
    throw new GhostError(
      "invalid_request",
      "The collaboration relay must be a ws:// or wss:// URL without credentials or a fragment.",
      400,
    );
  }
  return parsed.toString();
}

/**
 * The encrypted relay host is being ported from Oh My Pi to Ghost; until it
 * lands, starting a collaboration reports that honestly.
 */
const unavailableHost: CollaborationHostFactory = () => {
  throw new GhostError(
    "not_supported",
    "Remote collaboration is not available in this build of Ghost yet.",
    501,
  );
};

export class CollaborationManager {
  private readonly active = new Map<string, ActiveCollaboration>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly createHost: CollaborationHostFactory;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: CollaborationManagerOptions = {}) {
    this.createHost = options.createHost ?? unavailableHost;
  }

  status(sessionKey: string): CollaborationStatus {
    const active = this.active.get(sessionKey);
    if (!active) return { supported: true, active: false, participants: [] };
    const readOnlyUrl = active.host.webViewLink || active.host.viewLink;
    const writableUrl = active.host.webLink || active.host.link;
    return {
      supported: true,
      active: true,
      ...(readOnlyUrl ? { readOnlyUrl } : {}),
      ...(active.writable && writableUrl ? { writableUrl } : {}),
      participants: active.host.participants,
    };
  }

  private serialize<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionKey) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.operations.set(sessionKey, tail);
    void tail.then(() => {
      if (this.operations.get(sessionKey) === tail) this.operations.delete(sessionKey);
    });
    return result;
  }

  private async stopActive(sessionKey: string, reason: string): Promise<CollaborationStatus> {
    const active = this.active.get(sessionKey);
    if (!active) return this.status(sessionKey);
    this.active.delete(sessionKey);
    await active.host.stop(reason);
    return this.status(sessionKey);
  }

  async start(input: StartCollaborationInput): Promise<CollaborationStatus> {
    if (input.writable && input.confirmed !== true) {
      throw new GhostError(
        "confirmation_required",
        "Confirm that a writable link lets remote guests prompt the model and run this ghost's tools.",
        400,
      );
    }
    const relayUrl = normalizedRelayUrl(input.relayUrl);
    if (this.disposed) {
      throw new GhostError("session_closed", "The collaboration manager is closed.", 409);
    }

    return this.serialize(input.sessionKey, async () => {
      if (this.active.has(input.sessionKey)) return this.status(input.sessionKey);
      const session = input.session;
      const host = this.createHost({
        session,
        promptGuest: input.promptGuest ?? ((text) => session.prompt(text)),
        contextUsage: () => {
          const usage = session.getContextUsage();
          return {
            usedTokens: usage?.tokens ?? 0,
            contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
          };
        },
      });
      const webUrl = input.webUrl?.trim() || undefined;
      try {
        await host.start(relayUrl, webUrl);
      } catch (error) {
        await host.stop("startup failed").catch(() => {});
        throw error;
      }
      this.active.set(input.sessionKey, { host, writable: input.writable });
      return this.status(input.sessionKey);
    });
  }

  async stop(sessionKey: string, reason = "host stopped"): Promise<CollaborationStatus> {
    return this.serialize(sessionKey, () => this.stopActive(sessionKey, reason));
  }

  async disposeAll(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const sessionKeys = new Set([...this.operations.keys(), ...this.active.keys()]);
    this.disposePromise = Promise.allSettled(
      [...sessionKeys].map((sessionKey) =>
        this.serialize(sessionKey, () => this.stopActive(sessionKey, "daemon stopped"))),
    ).then(() => {});
    return this.disposePromise;
  }
}
