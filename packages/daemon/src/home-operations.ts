import { statSync } from "node:fs";
import { GhostError, type GhostRegistry } from "./ghosts.js";

interface HomeOperationState {
  active: number;
  moving: boolean;
  drained: (() => void) | null;
}

export interface HomeMoveParticipantReservation {
  drained: Promise<void>;
  release(): void;
}

export interface HomeMoveParticipant {
  preclaim?(ghostName: string): void;
  /** Reserve idle work synchronously, then expose its actual drain. */
  reserve(ghostName: string): HomeMoveParticipantReservation;
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
  private readonly moveParticipants = new Set<HomeMoveParticipant>();

  constructor(registry: GhostRegistry) {
    this.registry = registry;
  }

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

  registerMoveParticipant(participant: HomeMoveParticipant): () => void {
    this.moveParticipants.add(participant);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.moveParticipants.delete(participant);
    };
  }

  async reserveMove(ghostName: string): Promise<() => void> {
    const identity = homeIdentity(this.registry.get(ghostName).dir);
    // A move never cancels or waits for active owner/model work. Run every
    // participant's read-only precheck before taking any reservation so a
    // later participant cannot discover an owner after earlier work changed.
    for (const participant of this.moveParticipants) participant.preclaim?.(ghostName);
    const participantReservations: HomeMoveParticipantReservation[] = [];
    try {
      // Participants reserve synchronously: no new background generation can
      // slip between this call and the filesystem identity gate below.
      for (const participant of this.moveParticipants) {
        participantReservations.push(participant.reserve(ghostName));
      }
    } catch (error) {
      for (const reservation of participantReservations.reverse()) reservation.release();
      throw error;
    }
    const state = this.states.get(identity) ?? { active: 0, moving: false, drained: null };
    if (state.moving) {
      for (const reservation of participantReservations.reverse()) reservation.release();
      throw new GhostError("ghost_busy", "Another whole-home move is already in progress.", 409);
    }
    state.moving = true;
    this.states.set(identity, state);

    try {
      const activeDrained = state.active > 0
        ? new Promise<void>((resolve) => {
            state.drained = resolve;
          })
        : Promise.resolve();
      await Promise.all([
        activeDrained,
        ...participantReservations.map(({ drained }) => drained),
      ]);
    } catch (error) {
      state.moving = false;
      state.drained = null;
      if (state.active === 0) this.states.delete(identity);
      for (const reservation of participantReservations.reverse()) reservation.release();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.moving = false;
      if (state.active === 0) this.states.delete(identity);
      for (const reservation of participantReservations.reverse()) reservation.release();
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

export function homeOperationsFor(registry: GhostRegistry): HomeOperationCoordinator {
  const existing = sharedCoordinators.get(registry);
  if (existing) return existing;
  const created = new HomeOperationCoordinator(registry);
  sharedCoordinators.set(registry, created);
  return created;
}
