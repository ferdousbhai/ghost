import { GhostError } from "../errors.js";

/** How long a holder keeps the desktop after its last input. */
export const DESKTOP_LEASE_IDLE_MS = 15_000;

/**
 * Who may steer the one desktop right now. A caller's input op claims it; a
 * different caller's input fails `conflict` until the holder has been idle
 * for {@link DESKTOP_LEASE_IDLE_MS}, so two agents never interleave focus and
 * keystrokes. Reads never claim or wait.
 */
export class DesktopLease {
  private holder: string | null = null;
  private lastUsedAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The current holder and its idle time, or null when the desktop is free. */
  peek(): { holder: string; idleMs: number } | null {
    if (this.holder === null) return null;
    const idleMs = this.now() - this.lastUsedAt;
    if (idleMs >= DESKTOP_LEASE_IDLE_MS) {
      this.holder = null;
      return null;
    }
    return { holder: this.holder, idleMs };
  }

  /** Claim or renew for `caller`, or throw `conflict` naming the holder. */
  claim(caller: string): void {
    const held = this.peek();
    if (held && held.holder !== caller) {
      const waitS = Math.ceil((DESKTOP_LEASE_IDLE_MS - held.idleMs) / 1000);
      throw new GhostError(
        "conflict",
        `Another agent (${held.holder}) is steering the desktop. Reads still work; `
        + `input frees up after it has been idle ${waitS}s more.`,
        { holder: held.holder, retryAfterMs: DESKTOP_LEASE_IDLE_MS - held.idleMs },
      );
    }
    this.holder = caller;
    this.lastUsedAt = this.now();
  }
}

let shared: DesktopLease | null = null;

/** The per-daemon lease every desktop tool instance shares. */
export function getSharedDesktopLease(): DesktopLease {
  shared ??= new DesktopLease();
  return shared;
}
