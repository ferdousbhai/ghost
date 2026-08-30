export const HARNESS_IDS = ["claude-code", "codex", "pi"] as const;
export type HarnessId = typeof HARNESS_IDS[number];

export const LEGACY_WORKER_IDS = ["claude-code", "codex", "pi-worker"] as const;
export type LegacyWorkerId = typeof LEGACY_WORKER_IDS[number];

export function harnessFromLegacyWorker(id: LegacyWorkerId): HarnessId {
  return id === "pi-worker" ? "pi" : id;
}
