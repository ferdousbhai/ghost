import { statSync } from "node:fs";
import { GhostError, type GhostRegistry } from "./ghosts.js";

interface HomeOperationState {
  active: number;
  moving: boolean;
  drained: (() => void) | null;
}

function homeIdentity(dir: string): string {
  const stats = statSync(dir, { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

/**
 * Coordinates path-bound writes with whole-home moves by filesystem identity.
 * A rename changes the path but not the identity; deleting and recreating the
 * old name produces a different identity and therefore cannot inherit a gate.
 */
export class HomeOperationCoordinator {
  private readonly registry: GhostRegistry;
  private readonly states = new Map<string, HomeOperationState>();

  constructor(registry: GhostRegistry) {
    this.registry = registry;
  }

  /** Admit one operation before it resolves or captures a path inside the home. */
  acquire(ghostName: string): () => void {
    const identity = homeIdentity(this.registry.get(ghostName).dir);
    const state = this.states.get(identity) ?? { active: 0, moving: false, drained: null };
    if (state.moving) {
      throw new GhostError(
        "ghost_busy",
        "Wait for this ghost's home move to finish before changing its files.",
        409,
      );
    }
    state.active += 1;
    this.states.set(identity, state);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active -= 1;
      if (state.active === 0) {
        state.drained?.();
        state.drained = null;
        if (!state.moving) this.states.delete(identity);
      }
    };
  }

  async withLease<T>(ghostName: string, operation: () => T | Promise<T>): Promise<T> {
    const release = this.acquire(ghostName);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Block new leases, then wait for every operation admitted before the block. */
  async reserveMove(ghostName: string): Promise<() => void> {
    const identity = homeIdentity(this.registry.get(ghostName).dir);
    const state = this.states.get(identity) ?? { active: 0, moving: false, drained: null };
    if (state.moving) {
      throw new GhostError("ghost_busy", "Another whole-home move is already in progress.", 409);
    }
    state.moving = true;
    this.states.set(identity, state);

    if (state.active > 0) {
      await new Promise<void>((resolve) => {
        state.drained = resolve;
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.moving = false;
      if (state.active === 0) this.states.delete(identity);
    };
  }

  /** Diagnostics and deterministic race tests. */
  get moveReservationCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.moving) count += 1;
    }
    return count;
  }
}

const sharedCoordinators = new WeakMap<GhostRegistry, HomeOperationCoordinator>();

/** One coordinator per in-process registry unless an embedder supplies its own. */
export function homeOperationsFor(registry: GhostRegistry): HomeOperationCoordinator {
  const existing = sharedCoordinators.get(registry);
  if (existing) return existing;
  const created = new HomeOperationCoordinator(registry);
  sharedCoordinators.set(registry, created);
  return created;
}
