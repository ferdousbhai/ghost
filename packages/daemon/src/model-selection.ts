/**
 * The one model choice Ghost owns: `roles.chat_model` in the ghost's
 * `models.json`. pi owns providers, the catalog, and availability; Ghost only
 * records which model (or the Claude Code runtime) drives the ghost and
 * rebinds open conversations when that changes.
 */
import { CLAUDE_CODE_PROVIDER_ID } from "./claude-code.js";
import { ghostPaths, GhostError, type GhostRegistry } from "./ghosts.js";
import type { HomeOperationCoordinator } from "./home-operations.js";
import { readGhostModels, resolveChatModelRef, setGhostModelRole } from "./models.js";

export interface CurrentModel {
  current: { provider: string; id: string; runtime: "pi" | "claude-code" } | null;
  /** `explicit` when `models.json` binds the chat role; `none` leaves the choice to pi. */
  source: "explicit" | "none";
}

export interface ModelSelectionOptions {
  registry: GhostRegistry;
  homeOperations: HomeOperationCoordinator;
  /** Reaches open conversations so a switch applies without a new session. */
  onModelRoutingChanged?: (ghostName: string) => Promise<void> | void;
}

const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/u;

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
      const ref = resolveChatModelRef(readGhostModels(ghostPaths(ghost.dir).home));
      if (!ref) return { current: null, source: "none" };
      return {
        current: {
          provider: ref.provider,
          id: ref.modelId,
          runtime: ref.provider === CLAUDE_CODE_PROVIDER_ID ? "claude-code" : "pi",
        },
        source: "explicit",
      };
    });
  }

  async setChatModel(ghostName: string, provider: string, id: string): Promise<CurrentModel> {
    if (!SELECTOR.test(provider) || !SELECTOR.test(id)) {
      throw new GhostError("invalid_request", "A model is written as provider/id.", 400);
    }
    if (provider === CLAUDE_CODE_PROVIDER_ID && id !== "default") {
      throw new GhostError("invalid_request", `${provider}/${id} is not a model: the Claude Code runtime is selected as claude-code/default.`, 400);
    }
    const ghost = this.registry.get(ghostName);
    await this.homeOperations.withLease(ghostName, () => {
      setGhostModelRole(ghostPaths(ghost.dir).home, "chat_model", provider, id);
    });
    await this.onModelRoutingChanged?.(ghostName);
    return this.getCurrent(ghostName);
  }
}
