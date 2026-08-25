import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CollaborationManager } from "../src/collaboration.js";

function session(): AgentSession {
  return {
    getContextUsage: () => ({ tokens: 7, contextWindow: 100, percent: 7 }),
    model: { contextWindow: 100 },
    sessionManager: {},
    settings: { get: () => "https://collab.example/view" },
  } as unknown as AgentSession;
}

function fixture() {
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const host = {
    link: "omp-collab://relay/room#key.write",
    webLink: "https://collab.example/room#key.write",
    viewLink: "omp-collab://relay/room#key",
    webViewLink: "https://collab.example/room#key",
    participants: [{ name: "owner", role: "host" as const }],
    start,
    stop,
  };
  const createHost = vi.fn(() => host);
  const manager = new CollaborationManager({ createHost });
  return { manager, host, createHost, start, stop };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("CollaborationManager", () => {
  it("starts a read-only room without exposing its write token", async () => {
    const { manager, start } = fixture();

    const status = await manager.start({
      sessionKey: "ghost/session",
      session: session(),
      relayUrl: "relay.example/socket",
      writable: false,
      confirmed: false,
    });

    expect(start).toHaveBeenCalledWith(
      "wss://relay.example/socket",
      "https://collab.example/view",
    );
    expect(status).toEqual({
      supported: true,
      active: true,
      readOnlyUrl: "https://collab.example/room#key",
      participants: [{ name: "owner", role: "host" }],
    });
    expect(JSON.stringify(status)).not.toContain("key.write");
  });

  it("requires confirmation before returning a writable capability", async () => {
    const { manager, start } = fixture();
    const input = {
      sessionKey: "ghost/session",
      session: session(),
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: false,
    };

    await expect(manager.start(input)).rejects.toMatchObject({
      code: "confirmation_required",
      status: 400,
    });
    expect(start).not.toHaveBeenCalled();

    await expect(manager.start({ ...input, confirmed: true })).resolves.toMatchObject({
      writableUrl: "https://collab.example/room#key.write",
    });
  });

  it("rejects relay credentials and non-websocket schemes", async () => {
    const { manager } = fixture();
    for (const relayUrl of ["https://relay.example", "wss://user:pass@relay.example"]) {
      await expect(manager.start({
        sessionKey: relayUrl,
        session: session(),
        relayUrl,
        writable: false,
        confirmed: false,
      })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    }
  });

  it("stops a room and clears all capability links", async () => {
    const { manager, stop } = fixture();
    await manager.start({
      sessionKey: "ghost/session",
      session: session(),
      relayUrl: "wss://relay.example",
      writable: true,
      confirmed: true,
    });

    await expect(manager.stop("ghost/session")).resolves.toEqual({
      supported: true,
      active: false,
      participants: [],
    });
    expect(stop).toHaveBeenCalledWith("host stopped");
  });

  it("coalesces concurrent starts while the first host is still starting", async () => {
    const { manager, createHost, start } = fixture();
    const startup = deferred();
    start.mockImplementation(() => startup.promise);
    const input = {
      sessionKey: "ghost/session",
      session: session(),
      relayUrl: "wss://relay.example",
      writable: false,
      confirmed: false,
    };

    const first = manager.start(input);
    const second = manager.start(input);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(createHost).toHaveBeenCalledTimes(1);

    startup.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ active: true }),
      expect.objectContaining({ active: true }),
    ]);
    expect(createHost).toHaveBeenCalledTimes(1);
  });

  it("queues stop behind pending startup so the host cannot be orphaned", async () => {
    const { manager, start, stop } = fixture();
    const startup = deferred();
    start.mockImplementation(() => startup.promise);

    const starting = manager.start({
      sessionKey: "ghost/session",
      session: session(),
      relayUrl: "wss://relay.example",
      writable: false,
      confirmed: false,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const stopping = manager.stop("ghost/session", "conversation closed");
    expect(stop).not.toHaveBeenCalled();

    startup.resolve();
    await expect(starting).resolves.toMatchObject({ active: true });
    await expect(stopping).resolves.toEqual({
      supported: true,
      active: false,
      participants: [],
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith("conversation closed");
  });

  it("waits for pending startup during disposal and rejects later starts", async () => {
    const { manager, start, stop } = fixture();
    const startup = deferred();
    start.mockImplementation(() => startup.promise);
    const input = {
      sessionKey: "ghost/session",
      session: session(),
      relayUrl: "wss://relay.example",
      writable: false,
      confirmed: false,
    };

    const starting = manager.start(input);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const disposing = manager.disposeAll();
    expect(stop).not.toHaveBeenCalled();
    startup.resolve();

    await starting;
    await disposing;
    expect(manager.status("ghost/session")).toEqual({
      supported: true,
      active: false,
      participants: [],
    });
    expect(stop).toHaveBeenCalledWith("daemon stopped");
    await expect(manager.start(input)).rejects.toMatchObject({
      code: "session_closed",
      status: 409,
    });
  });
});
