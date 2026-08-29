import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Session-host and server tests each stand up a real pi AgentSession
    // against a local mock provider; give them room without being generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // pi's model runtime and session storage touch process-global state
    // (env, module caches); run files serially so tests never race.
    fileParallelism: false,
    // Bun-native dependencies (SQLite/WebSocket) must stay in the Bun host;
    // Vitest's default fork pool relaunches workers through Node semantics.
    pool: "threads",
  },
});
