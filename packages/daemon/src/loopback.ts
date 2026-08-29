import { createServer } from "node:net";

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback listener has no TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
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
