import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Session-host and server tests each stand up a real pi AgentSession
    // against a local mock provider; give them room without being generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // pi's model runtime and session storage are process-global in places
    // (env, jiti module cache); run files serially so tests never race.
    fileParallelism: false,
  },
});
