/**
 * The one model choice Ghost owns: `roles.chat_model` in the ghost's
 * `models.json`. pi owns providers, the catalog, and availability; Ghost only
 * records which model drives the ghost and rebinds open conversations when
 * that changes.
 */
import type { ConversationRuntime } from "./conversation-identity.js";
import { ghostPaths, GhostError, type GhostRegistry } from "./ghosts.js";
import type { HomeOperationCoordinator } from "./home-operations.js";
import {
  clearGhostModelRole,
  readGhostModels,
  resolveChatModelRef,
  resolveModelRoleRef,
  setGhostModelRole,
} from "./models.js";

export interface CurrentModel {
  current: { provider: string; id: string; runtime: ConversationRuntime } | null;
  /**
   * `explicit` when `models.json` binds the chat role. `none` means nothing is
   * bound: `current` is then whatever would answer anyway — the first declared
   * provider's model, or null when pi's own catalog default decides.
   */
  source: "explicit" | "none";
}

export interface ModelSelectionOptions {
  registry: GhostRegistry;
  homeOperations: HomeOperationCoordinator;
  /** Reaches open conversations so a switch applies without a new session. */
  onModelRoutingChanged?: (ghostName: string) => Promise<void> | void;
}

const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/u;
// Model ids also take `@`: Cloudflare's catalog ids read `@cf/meta/…`.
const MODEL_ID = /^[A-Za-z0-9@][A-Za-z0-9._:/+@-]{0,199}$/u;

/** Whether `provider/id` can be written as a binding; the model list offers only these. */
export function isChatModelSelector(provider: string, id: string): boolean {
  return PROVIDER.test(provider) && MODEL_ID.test(id);
}

export class ModelSelection {
  private readonly registry: GhostRegistry;
  private readonly homeOperations: HomeOperationCoordinator;
  private readonly onModelRoutingChanged: ModelSelectionOptions["onModelRoutingChanged"];

  constructor(options: ModelSelectionOptions) {
    this.registry = options.registry;
    this.homeOperations = options.homeOperations;
    this.onModelRoutingChanged = options.onModelRoutingChanged;
  }

  async getCurrent(ghostName: string): Promise<CurrentModel> {
    const ghost = this.registry.get(ghostName);
    return this.homeOperations.withLease(ghostName, () => {
      const models = readGhostModels(ghostPaths(ghost.dir).home);
      const ref = resolveChatModelRef(models);
      if (!ref) return { current: null, source: "none" };
      // `resolveChatModelRef` falls back to the first declared provider's
      // first model, so a value here does not mean the role is bound.
      // `resolveModelRoleRef` answers only for an explicit binding, which is
      // exactly the distinction this reports.
      return {
        current: { provider: ref.provider, id: ref.modelId, runtime: "pi" },
        source: resolveModelRoleRef(models, "chat_model") ? "explicit" : "none",
      };
    });
  }

  async setChatModel(ghostName: string, provider: string, id: string): Promise<CurrentModel> {
    if (!isChatModelSelector(provider, id)) {
      throw new GhostError("invalid_request", "A model is written as provider/id.", 400);
    }
    const ghost = this.registry.get(ghostName);
    await this.homeOperations.withLease(ghostName, () => {
      setGhostModelRole(ghostPaths(ghost.dir).home, "chat_model", provider, id);
    });
    await this.onModelRoutingChanged?.(ghostName);
    return this.getCurrent(ghostName);
  }

  /** The way out of a binding: unset the role and hand the choice back to pi. */
  async clearChatModel(ghostName: string): Promise<CurrentModel> {
    const ghost = this.registry.get(ghostName);
    await this.homeOperations.withLease(ghostName, () => {
      clearGhostModelRole(ghostPaths(ghost.dir).home, "chat_model");
    });
    await this.onModelRoutingChanged?.(ghostName);
    return this.getCurrent(ghostName);
  }
}
