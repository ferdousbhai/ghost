import { createServer, type Server } from "node:net";

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
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited before listening (${child.exitCode})`);
    }
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
