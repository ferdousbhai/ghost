export const WORKER_IDS = ["claude-code", "codex", "pi-worker"] as const;
export type WorkerId = typeof WORKER_IDS[number];
