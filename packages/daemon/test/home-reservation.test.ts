import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireHomeReservation, HomeReservationBusyError } from "../src/home-reservation.js";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function spawnReservationHolder(ghostsRoot: string, ready: string) {
  const moduleUrl = new URL("../src/home-reservation.ts", import.meta.url).href;
  const script = `
    import { writeFileSync } from "node:fs";
    import { acquireHomeReservation } from ${JSON.stringify(moduleUrl)};
    const reservation = await acquireHomeReservation(process.argv[1]);
    writeFileSync(process.argv[2], "ready");
    await new Promise(() => {});
    await reservation.close();
  `;
  return spawn(process.execPath, ["--eval", script, ghostsRoot, ready], {
    stdio: "pipe",
  });
}

describe("home reservation", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ghost-home-reservation-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses one key through a symlinked parent and releases explicitly", async () => {
    const realParent = join(root, "real");
    const aliasParent = join(root, "alias");
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent);
    const directRoot = join(realParent, "ghosts");
    const aliasRoot = join(aliasParent, "ghosts");

    const first = await acquireHomeReservation(directRoot);
    await expect(acquireHomeReservation(aliasRoot)).rejects.toBeInstanceOf(HomeReservationBusyError);
    await first.close();

    const second = await acquireHomeReservation(aliasRoot);
    await second.close();
  });

  it("rejects a symlinked gate directory", async () => {
    const parent = join(root, "parent");
    const outside = join(root, "outside");
    mkdirSync(parent);
    mkdirSync(outside);
    symlinkSync(outside, join(parent, ".ghost-home-gates"));

    await expect(acquireHomeReservation(join(parent, "ghosts"))).rejects.toSatisfy(
      (error: NodeJS.ErrnoException) => error.code === "ELOOP" || error.code === "ENOTDIR",
    );
  });

  it("conflicts across processes and is released by SIGKILL", async () => {
    const ghostsRoot = join(root, "nested", "ghosts");
    const ready = join(root, "ready");
    const holder = spawnReservationHolder(ghostsRoot, ready);
    let stderr = "";
    holder.stderr.setEncoding("utf8");
    holder.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await waitForFile(ready);
    await expect(acquireHomeReservation(ghostsRoot)).rejects.toBeInstanceOf(HomeReservationBusyError);

    const exited = new Promise<void>((resolveExit) => holder.once("exit", () => resolveExit()));
    holder.kill("SIGKILL");
    await exited;
    expect(stderr).toBe("");

    const recovered = await acquireHomeReservation(ghostsRoot);
    await recovered.close();
  });
});
