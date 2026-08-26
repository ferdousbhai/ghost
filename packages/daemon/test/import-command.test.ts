import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireHomeReservation, HomeReservationBusyError } from "../src/home-reservation.js";
import { importCommand, parseImportArgs } from "../src/import-command.js";

/**
 * A minimal, valid ghost-home/v1 archive as an extracted directory —
 * `importGhostArchive` accepts a directory or a zip, and a directory keeps the
 * daemon test free of a zip dependency.
 */
function makeArchiveDir(parent: string, ghostname: string): string {
  const dir = join(parent, `${ghostname}-archive`, ghostname);
  mkdirSync(join(dir, "memory"), { recursive: true });
  const manifest = {
    format: "ghost-home/v1",
    ghostname,
    exportedAt: "2026-08-22T00:00:00.000Z",
  };
  writeFileSync(join(dir, "export-manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "character.md"), "---\ntitle: imported\n---\n\nI am a ghost.\n");
  writeFileSync(join(dir, "memory", "tone.md"), "---\ndescription: tone\n---\n\nTerse.\n");
  return dir;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener has no TCP port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function listen(host: string, port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolveListen);
  });
  return server;
}

async function closeListener(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function collectProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  child: ChildProcessWithoutNullStreams;
  result: Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const child = spawn(process.execPath, args, { env, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`ghostd subprocess exited from ${signal}: ${stderr}`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return { child, result };
}

async function waitUntilServing(port: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited before listening (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/relay/status`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon did not listen on port ${port}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(forced);
}

async function waitForFile(path: string, child?: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`subprocess exited before creating ${path} (${child.exitCode})`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function isolatedEnv(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GHOSTD_CONFIG",
    "GHOSTD_HOST",
    "GHOSTD_PORT",
    "GHOSTS_ROOT",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    GHOSTD_RELAY: "0",
    ...overrides,
  };
}

function collectPausedMain(
  args: string[],
  env: NodeJS.ProcessEnv,
  ready: string,
  release: string,
): ReturnType<typeof collectProcess> {
  const mainUrl = new URL("../src/main.ts", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { main } from ${JSON.stringify(mainUrl)};
    const code = await main(process.argv.slice(1), {
      afterHomeReservationAcquired: async () => {
        writeFileSync(process.env.GHOST_TEST_READY, "ready");
        while (!existsSync(process.env.GHOST_TEST_RELEASE)) await Bun.sleep(10);
      },
    });
    process.exitCode = code;
  `;
  return collectProcess(
    ["--eval", script, "--", ...args],
    { ...env, GHOST_TEST_READY: ready, GHOST_TEST_RELEASE: release },
  );
}

function collectPausedLogin(
  args: string[],
  env: NodeJS.ProcessEnv,
  ready: string,
  release: string,
): ReturnType<typeof collectProcess> {
  const loginUrl = new URL("../src/login-command.ts", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { loginCommand } from ${JSON.stringify(loginUrl)};
    const code = await loginCommand(process.argv.slice(1), {
      afterHomeReservationAcquired: async () => {
        writeFileSync(process.env.GHOST_TEST_READY, "ready");
        while (!existsSync(process.env.GHOST_TEST_RELEASE)) await Bun.sleep(10);
      },
    });
    process.exitCode = code;
  `;
  return collectProcess(
    ["--eval", script, "--", ...args],
    { ...env, GHOST_TEST_READY: ready, GHOST_TEST_RELEASE: release },
  );
}

describe("parseImportArgs", () => {
  it("reads the source, name, overwrite, and root", () => {
    const args = parseImportArgs([
      "a.zip", "--name", "casper", "--overwrite", "--port", "7788",
      "--host", "::1", "--ghosts-root", "/g",
    ]);
    expect(args.source).toBe("a.zip");
    expect(args.name).toBe("casper");
    expect(args.overwrite).toBe(true);
    expect(args.overrides.port).toBe(7788);
    expect(args.overrides.host).toBe("::1");
    expect(args.overrides.ghostsRoot).toBe("/g");
  });

  it("rejects a second positional and unknown flags", () => {
    expect(() => parseImportArgs(["a.zip", "b.zip"])).toThrow(/Unexpected argument/);
    expect(() => parseImportArgs(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseImportArgs(["a.zip", "--port", "nope"])).toThrow(/Invalid port/);
    expect(() => parseImportArgs(["a.zip", "--host"])).toThrow(/requires a value/);
  });
});

describe("importCommand", () => {
  let root: string;
  let out: string[];
  let err: string[];
  const io = () => ({
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ghost-import-"));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("imports an archive into <ghostsRoot>/<name>", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");

    const code = await importCommand([archive, "--ghosts-root", ghostsRoot], io());

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/Imported "casper"/);
    expect(readFileSync(join(ghostsRoot, "casper", "character.md"), "utf8")).toContain("I am a ghost.");
    expect(readFileSync(join(ghostsRoot, "casper", "memory", "tone.md"), "utf8")).toContain("Terse.");
  });

  it("refuses a new-home import while another process owns the ghosts root", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const reservation = await acquireHomeReservation(ghostsRoot);
    try {
      const code = await importCommand([archive, "--ghosts-root", ghostsRoot], io());
      expect(code).toBe(1);
      expect(err.join("")).toMatch(/refusing import: ghostd is running or starting/);
      expect(existsSync(join(ghostsRoot, "casper"))).toBe(false);
    } finally {
      await reservation.close();
    }
  });

  it("--name overrides the archive's ghostname", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");

    const code = await importCommand([archive, "--name", "mildred", "--ghosts-root", ghostsRoot], io());

    expect(code).toBe(0);
    expect(readFileSync(join(ghostsRoot, "mildred", "character.md"), "utf8")).toContain("I am a ghost.");
  });

  it("activates hosted conversations while preserving their source JSON", async () => {
    const archive = makeArchiveDir(root, "casper");
    const conversations = join(archive, "conversations");
    mkdirSync(conversations, { recursive: true });
    const source = JSON.stringify({
      id: "old-chat",
      catalog: {
        id: "old-chat",
        title: "Old chat title",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      messages: [
        {
          id: "old-user",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          id: "old-assistant",
          role: "assistant",
          parts: [{ type: "step-start" }, { type: "text", text: "hi" }],
        },
      ],
    });
    writeFileSync(join(conversations, "old-chat.json"), source);
    const ghostsRoot = join(root, "ghosts");

    const code = await importCommand([archive, "--ghosts-root", ghostsRoot], io());

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/1 hosted conversation activated/);
    expect(readFileSync(join(ghostsRoot, "casper", "conversations", "old-chat.json"), "utf8")).toBe(source);
    expect(readFileSync(join(ghostsRoot, "casper", ".sessions", "old-chat.jsonl"), "utf8")).toContain(
      '"title":"Old chat title"',
    );
  });

  it("refuses a non-empty home without --overwrite, then accepts it with", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    mkdirSync(join(ghostsRoot, "casper"), { recursive: true });
    writeFileSync(join(ghostsRoot, "casper", "keep.md"), "existing");

    const refused = await importCommand([archive, "--ghosts-root", ghostsRoot], io());
    expect(refused).toBe(1);
    expect(err.join("")).toMatch(/already exists/);

    const port = await freeLoopbackPort();
    const accepted = await importCommand(
      [archive, "--ghosts-root", ghostsRoot, "--overwrite", "--port", String(port)],
      io(),
    );
    expect(accepted).toBe(0);
  });

  it("allows a stopped-daemon overwrite with an ephemeral daemon port", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Keep\n");

    const code = await importCommand([archive, "--ghosts-root", ghostsRoot, "--overwrite", "--port", "0"], io());

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(readFileSync(join(home, "character.md"), "utf8")).toContain("I am a ghost.");
  });

  it.each([
    { listenerHost: "127.0.0.1", importHost: "127.0.0.1" },
    { listenerHost: "::1", importHost: "::1" },
    { listenerHost: "127.0.0.1", importHost: "localhost" },
    { listenerHost: "::1", importHost: "localhost" },
  ])(
    "refuses a legacy daemon on $listenerHost through --host $importHost",
    async ({ listenerHost, importHost }) => {
      const archive = makeArchiveDir(root, "casper");
      const ghostsRoot = join(root, "ghosts");
      const home = join(ghostsRoot, "casper");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "character.md"), "# Before\n");
      const listener = await listen(listenerHost);
      const address = listener.address();
      if (address === null || typeof address === "string") throw new Error("listener has no port");
      const args = [
        archive,
        "--overwrite",
        "--host",
        importHost,
        "--port",
        String(address.port),
        "--ghosts-root",
        ghostsRoot,
      ];

      try {
        const blocked = await importCommand(args, io());
        expect(blocked).toBe(1);
        expect(err.join("")).toMatch(/refusing --overwrite: ghostd is running/);
        const endpoint = importHost === "::1" ? `[::1]:${address.port}` : `${importHost}:${address.port}`;
        expect(err.join("")).toContain(endpoint);
        expect(readFileSync(join(home, "character.md"), "utf8")).toBe("# Before\n");
      } finally {
        await closeListener(listener);
      }
      err = [];
      expect(await importCommand(args, io())).toBe(0);
    },
    30_000,
  );

  it("holds the legacy listener through publication and closes it before the home reservation", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Before\n");
    const port = await freeLoopbackPort();
    let observedPublication = false;
    let observedReleaseOrder = false;

    const code = await importCommand(
      [archive, "--overwrite", "--host", "127.0.0.1", "--port", String(port), "--ghosts-root", ghostsRoot],
      io(),
      {
        afterArchivePublished: async () => {
          await expect(listen("127.0.0.1", port)).rejects.toMatchObject({ code: "EADDRINUSE" });
          expect(readFileSync(join(home, "character.md"), "utf8")).toContain("I am a ghost.");
          observedPublication = true;
        },
        afterLegacyPortReservationReleased: async () => {
          const listener = await listen("127.0.0.1", port);
          try {
            await expect(acquireHomeReservation(ghostsRoot)).rejects.toBeInstanceOf(
              HomeReservationBusyError,
            );
            observedReleaseOrder = true;
          } finally {
            await closeListener(listener);
          }
        },
      },
    );

    expect(code).toBe(0);
    expect(observedPublication).toBe(true);
    expect(observedReleaseOrder).toBe(true);
    const released = await acquireHomeReservation(ghostsRoot);
    await released.close();
  });

  it("refuses live-daemon overwrite publication, then imports after that daemon stops", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Before\n\nThe live daemon owns this home.\n");

    const port = await freeLoopbackPort();
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const env = isolatedEnv(root, {
      GHOSTD_PORT: String(port),
      GHOSTS_ROOT: ghostsRoot,
    });
    const daemon = collectProcess([entry, "--offline", "--log-level", "error"], env);

    try {
      await waitUntilServing(port, daemon.child);
      const blocked = await collectProcess([entry, "import", archive, "--overwrite", "--port", "0"], env).result;

      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toMatch(/refusing --overwrite: ghostd is running or starting/);
      expect(blocked.stderr).toMatch(/systemctl --user stop ghostd\.service/);
      expect(readFileSync(join(home, "character.md"), "utf8")).toContain("The live daemon owns");
      expect(existsSync(join(home, "memory", "tone.md"))).toBe(false);
    } finally {
      await stopProcess(daemon.child);
      await daemon.result;
    }

    const stopped = await collectProcess([entry, "import", archive, "--overwrite", "--port", "0"], env).result;
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toMatch(/Imported "casper"/);
    expect(readFileSync(join(home, "character.md"), "utf8")).toContain("I am a ghost.");
    expect(readFileSync(join(home, "memory", "tone.md"), "utf8")).toContain("Terse.");
  }, 30_000);

  it("prevents daemon startup during the complete overwrite transaction", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Before\n");

    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolveAcquired) => {
      signalAcquired = resolveAcquired;
    });
    let releaseOverwrite!: () => void;
    const released = new Promise<void>((resolveReleased) => {
      releaseOverwrite = resolveReleased;
    });
    const importing = importCommand([archive, "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot], io(), {
      afterOverwriteReservationAcquired: async () => {
        signalAcquired();
        await released;
      },
    });
    await acquired;

    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const startup = await collectProcess(
      [entry, "--offline", "--log-level", "error", "--port", "0", "--ghosts-root", ghostsRoot],
      isolatedEnv(root),
    ).result;

    expect(startup.code).toBe(1);
    expect(startup.stderr).toMatch(/could not reserve the ghost home/);
    expect(startup.stderr).toMatch(/import\/login is in progress/);
    const blockedLogin = await collectProcess(
      [entry, "login", "casper", "--offline", "--ghosts-root", ghostsRoot],
      isolatedEnv(root),
    ).result;
    expect(blockedLogin.code).toBe(1);
    expect(blockedLogin.stdout).toMatch(/another login\/import is active/);
    expect(blockedLogin.stdout).toMatch(/systemctl --user stop ghostd\.service/);
    expect(readFileSync(join(home, "character.md"), "utf8")).toBe("# Before\n");

    releaseOverwrite();
    expect(await importing).toBe(0);
    expect(readFileSync(join(home, "character.md"), "utf8")).toContain("I am a ghost.");
  }, 30_000);

  it("prevents overwrite during startup and releases after startup failure", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Before\n");

    const occupied = createServer();
    await new Promise<void>((resolveListen, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolveListen);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("occupied listener has no TCP port");
    }

    const ready = join(root, "startup-ready");
    const release = join(root, "startup-release");
    const startup = collectPausedMain(
      [
        "--offline",
        "--log-level",
        "error",
        "--port",
        String(address.port),
        "--ghosts-root",
        ghostsRoot,
      ],
      isolatedEnv(root),
      ready,
      release,
    );

    try {
      await waitForFile(ready, startup.child);
      const blocked = await importCommand([archive, "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot], io());
      expect(blocked).toBe(1);
      expect(err.join("")).toMatch(/ghostd is running or starting/);
      expect(readFileSync(join(home, "character.md"), "utf8")).toBe("# Before\n");

      writeFileSync(release, "release");
      const failedStartup = await startup.result;
      expect(failedStartup.code).toBe(1);
      expect(failedStartup.stderr).toMatch(/could not bind/);
    } finally {
      writeFileSync(release, "release");
      await stopProcess(startup.child);
      await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
    }

    err = [];
    const recovered = await importCommand([archive, "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot], io());
    expect(recovered).toBe(0);
  }, 30_000);

  it("serves the reserved canonical root after its config symlink is retargeted", async () => {
    const firstRoot = join(root, "daemon-first-root");
    const secondRoot = join(root, "daemon-second-root");
    const configuredRoot = join(root, "daemon-configured-root");
    mkdirSync(join(firstRoot, "alpha"), { recursive: true });
    writeFileSync(join(firstRoot, "alpha", "character.md"), "# Alpha\n");
    mkdirSync(join(secondRoot, "beta"), { recursive: true });
    writeFileSync(join(secondRoot, "beta", "character.md"), "# Beta\n");
    symlinkSync(firstRoot, configuredRoot);

    const port = await freeLoopbackPort();
    const ready = join(root, "canonical-startup-ready");
    const release = join(root, "canonical-startup-release");
    const apiTokenPath = join(root, "canonical-api-token");
    const daemon = collectPausedMain(
      [
        "--offline",
        "--log-level",
        "error",
        "--port",
        String(port),
        "--ghosts-root",
        configuredRoot,
      ],
      isolatedEnv(root, { GHOSTD_API_TOKEN_FILE: apiTokenPath }),
      ready,
      release,
    );

    try {
      await waitForFile(ready, daemon.child);
      unlinkSync(configuredRoot);
      symlinkSync(secondRoot, configuredRoot);
      writeFileSync(release, "release");
      await waitUntilServing(port, daemon.child);

      const token = readFileSync(apiTokenPath, "utf8").trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/ghosts`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({ name: "alpha", dir: join(firstRoot, "alpha") }),
      ]);
      expect(existsSync(join(firstRoot, "alpha", "memory"))).toBe(true);
      expect(existsSync(join(secondRoot, "beta", "memory"))).toBe(false);
    } finally {
      writeFileSync(release, "release");
      await stopProcess(daemon.child);
      await daemon.result;
    }
  }, 30_000);

  it("allows only one concurrent overwrite to publish", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Before\n");

    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolveAcquired) => {
      signalAcquired = resolveAcquired;
    });
    let releaseFirst!: () => void;
    const released = new Promise<void>((resolveReleased) => {
      releaseFirst = resolveReleased;
    });
    const first = importCommand([archive, "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot], io(), {
      afterOverwriteReservationAcquired: async () => {
        signalAcquired();
        await released;
      },
    });
    await acquired;

    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const second = await collectProcess(
      [entry, "import", archive, "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot],
      isolatedEnv(root),
    ).result;
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/another import\/login is active/);
    expect(readFileSync(join(home, "character.md"), "utf8")).toBe("# Before\n");

    releaseFirst();
    expect(await first).toBe(0);
    expect(readFileSync(join(home, "character.md"), "utf8")).toContain("I am a ghost.");
  });

  it("refuses overwrite throughout a terminal login home-access window", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "ghosts");
    const home = join(ghostsRoot, "casper");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "character.md"), "# Before\n");
    const ready = join(root, "login-ready");
    const release = join(root, "login-release");
    const login = collectPausedLogin(
      ["missing", "--offline", "--ghosts-root", ghostsRoot],
      isolatedEnv(root),
      ready,
      release,
    );

    try {
      await waitForFile(ready, login.child);
      const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
      const blocked = await collectProcess(
        [entry, "import", archive, "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot],
        isolatedEnv(root),
      ).result;
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toMatch(/ghostd is running or starting, or another import\/login is active/);
      expect(readFileSync(join(home, "character.md"), "utf8")).toBe("# Before\n");
    } finally {
      writeFileSync(release, "release");
    }
    const loginResult = await login.result;
    expect(loginResult.code).toBe(1);
    expect(loginResult.stdout).toMatch(/No ghost named "missing"/);

    const released = await acquireHomeReservation(ghostsRoot);
    await released.close();
  }, 30_000);

  it("publishes through the reserved canonical root after its config symlink is retargeted", async () => {
    const archive = makeArchiveDir(root, "casper");
    const firstRoot = join(root, "first-root");
    const secondRoot = join(root, "second-root");
    const configuredRoot = join(root, "configured-root");
    for (const target of [firstRoot, secondRoot]) {
      const home = join(target, "casper");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "character.md"), `# Before ${target}\n`);
    }
    symlinkSync(firstRoot, configuredRoot);

    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolveAcquired) => {
      signalAcquired = resolveAcquired;
    });
    let releaseImport!: () => void;
    const released = new Promise<void>((resolveReleased) => {
      releaseImport = resolveReleased;
    });
    const importing = importCommand(
      [archive, "--overwrite", "--port", "0", "--ghosts-root", configuredRoot],
      io(),
      {
        afterOverwriteReservationAcquired: async () => {
          signalAcquired();
          await released;
        },
      },
    );
    await acquired;

    unlinkSync(configuredRoot);
    symlinkSync(secondRoot, configuredRoot);
    releaseImport();
    expect(await importing).toBe(0);

    expect(readFileSync(join(firstRoot, "casper", "character.md"), "utf8")).toContain("I am a ghost.");
    expect(readFileSync(join(firstRoot, "casper", "memory", "tone.md"), "utf8")).toContain("Terse.");
    expect(readFileSync(join(secondRoot, "casper", "character.md"), "utf8")).toBe(`# Before ${secondRoot}\n`);
    expect(existsSync(join(secondRoot, "casper", "memory", "tone.md"))).toBe(false);
  });

  it("releases the reservation when an overwrite fails before publication", async () => {
    const ghostsRoot = join(root, "ghosts");
    const code = await importCommand(
      [join(root, "missing"), "--overwrite", "--port", "0", "--ghosts-root", ghostsRoot],
      io(),
    );
    expect(code).toBe(1);

    const reservation = await acquireHomeReservation(ghostsRoot);
    await reservation.close();
  });

  it("uses the same reservation through config, environment, and defaults", async () => {
    const archive = makeArchiveDir(root, "casper");
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

    const configRoot = join(root, "from-config", "ghosts");
    const configPath = join(root, "daemon-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ghostsRoot: configRoot,
        host: "localhost",
        port: 0,
      }),
    );
    const configReservation = await acquireHomeReservation(configRoot);
    const configured = await collectProcess(
      [entry, "import", archive, "--overwrite", "--config", configPath],
      isolatedEnv(root),
    ).result;
    expect(configured.code).toBe(1);
    expect(configured.stderr).toMatch(/ghostd is running or starting/);
    await configReservation.close();

    const environmentRoot = join(root, "from-env", "ghosts");
    const environmentReservation = await acquireHomeReservation(environmentRoot);
    const fromEnvironment = await collectProcess(
      [entry, "import", archive, "--overwrite"],
      isolatedEnv(root, {
        GHOSTD_HOST: "localhost",
        GHOSTD_PORT: "0",
        GHOSTS_ROOT: environmentRoot,
      }),
    ).result;
    expect(fromEnvironment.code).toBe(1);
    expect(fromEnvironment.stderr).toMatch(/ghostd is running or starting/);
    await environmentReservation.close();

    const defaultHome = join(root, "default-home");
    const defaultRoot = join(defaultHome, "ghosts");
    const defaultReservation = await acquireHomeReservation(defaultRoot);
    const fromDefaults = await collectProcess(
      [entry, "import", archive, "--overwrite", "--port", "0"],
      isolatedEnv(root, { HOME: defaultHome }),
    ).result;
    expect(fromDefaults.code).toBe(1);
    expect(fromDefaults.stderr).toMatch(/ghostd is running or starting/);
    await defaultReservation.close();

    const unsafeConfig = join(root, "unsafe-config.json");
    writeFileSync(
      unsafeConfig,
      JSON.stringify({
        ghostsRoot: join(root, "unsafe", "ghosts"),
        host: "0.0.0.0",
        port: 0,
      }),
    );
    const nonLoopback = await collectProcess(
      [entry, "import", archive, "--overwrite", "--config", unsafeConfig],
      isolatedEnv(root),
    ).result;
    expect(nonLoopback.code).toBe(1);
    expect(nonLoopback.stderr).toMatch(/binds loopback only/);
  }, 30_000);

  it("fails cleanly on a missing archive", async () => {
    const code = await importCommand([join(root, "nope-archive"), "--ghosts-root", join(root, "ghosts")], io());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/import:/);
  });

  it("returns usage code 2 with no source", async () => {
    const code = await importCommand(["--ghosts-root", join(root, "ghosts")], io());
    expect(code).toBe(2);
  });
});
