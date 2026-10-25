import { createServer, type Server } from "node:net";

/** The peer addresses a loopback connection arrives from. */
export const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Ports handed out to a process that binds them later. Drawn at random from
 * below the ephemeral range (Linux: 32768+), so a port-0 listener elsewhere
 * cannot be given the same number between our probe and their bind.
 */
const PORT_FLOOR = 20_000;
const PORT_CEILING = 29_999;

function listenOnce(host: string, port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/** A loopback port on `host` that was bindable a moment ago. */
export async function freePort(host = "127.0.0.1"): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = PORT_FLOOR + Math.floor(Math.random() * (PORT_CEILING - PORT_FLOOR + 1));
    try {
      await closeServer(await listenOnce(host, port));
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`no free loopback port found in ${PORT_FLOOR}-${PORT_CEILING}`);
}

export async function waitUntilServing(
  port: number,
  child: { exitCode: number | null },
): Promise<void> {
  // Generous on purpose: a cold start on a slow or emulated machine (the
  // aarch64 proof for ghost#52 took eight seconds) must not read as failure.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited before listening (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200 || response.status === 401) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon did not listen on port ${port}`);
}
