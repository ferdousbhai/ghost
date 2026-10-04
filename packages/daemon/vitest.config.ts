import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Session-host and server tests spawn a scripted harness process per
    // turn; give them room without being generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests point process-global env (XDG dirs) at scratch state; run files
    // serially so they never race.
    fileParallelism: false,
    // Bun-native dependencies (SQLite/WebSocket) must stay in the Bun host;
    // Vitest's default fork pool relaunches workers through Node semantics.
    pool: "threads",
  },
});
