import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalModel } from "../src/local-model.js";
import { tempDir } from "./helpers/fixtures.js";

it("fails to start cleanly when llama-server is missing, and stopping still resolves", async () => {
  const { path: directory, cleanup } = tempDir();
  const model = new LocalModel({
    model: join(directory, "model.gguf"),
    server: join(directory, "no-such-llama-server"),
    contextSize: 1024,
    idleMs: 60_000,
  }, { info: () => {}, warn: () => {} });
  await expect(model.acquire()).rejects.toThrow(/could not start/u);
  // Under Bun a failed spawn never emits `exit`; a stop that waited for one
  // would hang the daemon's shutdown until systemd killed it.
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<"hung">((resolve) => { timer = setTimeout(() => resolve("hung"), 3_000); });
  expect(await Promise.race([model.stop("test").then(() => "stopped" as const), hung])).toBe("stopped");
  clearTimeout(timer);
  cleanup();
}, 10_000);
