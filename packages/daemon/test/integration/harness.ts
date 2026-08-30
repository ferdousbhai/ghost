/**
 * Real-daemon integration harness.
 *
 * This boots the production Registry -> SessionHost -> HTTP server chain on an
 * ephemeral loopback port. The ghost home, XDG roots, and process HOME all
 * point inside one OS-temp directory, inherited provider credentials are
 * scrubbed before Pi is constructed, and the only model endpoint is the
 * scripted loopback provider.
 *
 * The clients below use node:http with pooling disabled. SSE is decoded from
 * the bytes delivered by the real socket; no EventSource or route stub sits in
 * the path.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProviderCredentialEnv, scrubProviderEnv } from "../../src/env-scrub.js";
import { GhostRegistry } from "../../src/ghosts.js";
import { HomeOperationCoordinator } from "../../src/home-operations.js";
import { McpCatalog } from "../../src/mcp-catalog.js";
import type { PiMessagesEvent } from "../../src/pi-messages.js";
import { startDaemonServer, type ListeningServer } from "../../src/server.js";
import { SessionHost } from "../../src/session-host.js";
import { seedGhost } from "../helpers/fixtures.js";
import {
  startMockProvider,
  type MockProvider,
  type MockProviderOptions,
} from "../helpers/mock-provider.js";

const API_TOKEN = "a".repeat(64);
const DEFAULT_WAIT_MS = 5_000;

export interface JsonResponse<T = unknown> {
  status: number;
  headers: IncomingHttpHeaders;
  body: T;
  raw: string;
}

export interface SseWireFrame {
  raw: string;
  data?: string;
  event?: PiMessagesEvent;
}

interface FrameWaiter {
  predicate: (frame: SseWireFrame) => boolean;
  resolve: (frame: SseWireFrame) => void;
  reject: (error: Error) => void;
}

export function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class RealSseClient {
  readonly frames: SseWireFrame[] = [];
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly completion: Promise<{ naturalEnd: boolean }>;

  private buffer = "";
  private completed = false;
  private disconnected = false;
  private readonly response: IncomingMessage;
  private readonly waiters: FrameWaiter[] = [];
  private finishCompletion!: (result: { naturalEnd: boolean }) => void;
  private failCompletion!: (error: Error) => void;
  private readonly onClosed: () => void;

  constructor(response: IncomingMessage, onClosed: () => void) {
    this.response = response;
    this.status = response.statusCode ?? 0;
    this.headers = response.headers;
    this.onClosed = onClosed;
    this.completion = new Promise((resolve, reject) => {
      this.finishCompletion = resolve;
      this.failCompletion = reject;
    });

    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      try {
        this.buffer += chunk.replace(/\r\n/g, "\n");
        this.drainFrames();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    response.once("end", () => {
      if (this.buffer.length > 0) {
        this.publishFrame(this.buffer);
        this.buffer = "";
      }
      this.finish(true);
    });
    response.once("aborted", () => {
      if (this.disconnected) this.finish(false);
      else this.fail(new Error("The SSE response was aborted before EOF."));
    });
    response.once("error", (error) => {
      if (this.disconnected) this.finish(false);
      else this.fail(error);
    });
    response.once("close", () => {
      if (!this.completed) {
        if (this.disconnected) this.finish(false);
        else this.fail(new Error("The SSE socket closed before EOF."));
      }
    });
  }

  get events(): PiMessagesEvent[] {
    return this.frames.flatMap((frame) => frame.event ? [frame.event] : []);
  }

  waitForFrame(
    predicate: (frame: SseWireFrame) => boolean,
    label = "an SSE frame",
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<SseWireFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.completed) {
      return Promise.reject(new Error(`The SSE stream ended before ${label}.`));
    }
    const pending = new Promise<SseWireFrame>((resolve, reject) => {
      this.waiters.push({ predicate, resolve, reject });
    });
    return within(pending, label, timeoutMs);
  }

  waitForEvent(
    predicate: PiMessagesEvent["type"] | ((event: PiMessagesEvent) => boolean),
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<PiMessagesEvent> {
    const matches = typeof predicate === "string"
      ? (event: PiMessagesEvent) => event.type === predicate
      : predicate;
    return this.waitForFrame(
      (frame) => frame.event !== undefined && matches(frame.event),
      typeof predicate === "string" ? `${predicate} SSE event` : "matching SSE event",
      timeoutMs,
    ).then((frame) => frame.event as PiMessagesEvent);
  }

  disconnect(): void {
    if (this.completed || this.disconnected) return;
    this.disconnected = true;
    this.response.destroy();
  }

  private drainFrames(): void {
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (raw.length > 0) this.publishFrame(raw);
      boundary = this.buffer.indexOf("\n\n");
    }
  }

  private publishFrame(raw: string): void {
    const data = raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    const frame: SseWireFrame = {
      raw,
      ...(data ? { data } : {}),
      ...(data && data !== "[DONE]"
        ? { event: JSON.parse(data) as PiMessagesEvent }
        : {}),
    };
    this.frames.push(frame);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (!waiter?.predicate(frame)) continue;
      this.waiters.splice(index, 1);
      waiter.resolve(frame);
    }
  }

  private finish(naturalEnd: boolean): void {
    if (this.completed) return;
    this.completed = true;
    this.onClosed();
    const error = new Error("The SSE stream ended before the awaited frame arrived.");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.finishCompletion({ naturalEnd });
  }

  private fail(error: Error): void {
    if (this.completed) return;
    this.completed = true;
    this.onClosed();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.failCompletion(error);
    if (!this.response.destroyed) this.response.destroy(error);
  }
}

export interface RealDaemonHarnessOptions {
  script: MockProviderOptions["script"];
  provider?: Omit<MockProviderOptions, "script">;
  ghostName?: string;
}

export interface RealDaemonHarness {
  readonly tempRoot: string;
  readonly ghostsRoot: string;
  readonly ghostHome: string;
  readonly ghostName: string;
  readonly port: number;
  readonly provider: MockProvider;
  readonly host: SessionHost;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<JsonResponse<T>>;
  startTurn(sessionId: string, prompt: string): Promise<RealSseClient>;
  close(): Promise<void>;
}

function assertLocalPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Harness requests need a daemon-relative path, got ${JSON.stringify(path)}.`);
  }
}

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(snapshot)) {
    if (value !== undefined) process.env[name] = value;
  }
}

export async function startRealDaemonHarness(
  options: RealDaemonHarnessOptions,
): Promise<RealDaemonHarness> {
  const environment = { ...process.env };
  const tempRoot = mkdtempSync(join(tmpdir(), "ghostd-integration-"));
  const ghostsRoot = join(tempRoot, "ghosts");
  const disposableHome = join(tempRoot, "home");
  const xdgConfigHome = join(tempRoot, "xdg-config");
  const xdgDataHome = join(tempRoot, "xdg-data");
  const xdgStateHome = join(tempRoot, "xdg-state");
  for (const path of [ghostsRoot, disposableHome, xdgConfigHome, xdgDataHome, xdgStateHome]) {
    mkdirSync(path, { recursive: true });
  }

  process.env.HOME = disposableHome;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  process.env.XDG_DATA_HOME = xdgDataHome;
  process.env.XDG_STATE_HOME = xdgStateHome;
  process.env.GHOSTS_ROOT = ghostsRoot;
  process.env.GHOSTD_CONFIG = join(xdgConfigHome, "ghost", "config.json");
  process.env.GHOSTD_HOOKS = join(xdgConfigHome, "ghost", "hooks.json");
  process.env.GHOSTD_API_TOKEN_FILE = join(xdgStateHome, "ghost", "api-token");
  process.env.GHOSTD_RELAY_TOKEN_FILE = join(xdgStateHome, "ghost", "relay-token");
  process.env.GHOSTD_RELAY = "off";
  scrubProviderEnv(process.env, { offline: true });
  if (findProviderCredentialEnv(process.env).length > 0) {
    restoreEnvironment(environment);
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error("The integration harness did not scrub every provider credential variable.");
  }

  let provider: MockProvider | null = null;
  let host: SessionHost | null = null;
  let listening: ListeningServer | null = null;
  const clients = new Set<RealSseClient>();
  try {
    const registry = new GhostRegistry(ghostsRoot);
    registry.ensureRoot();
    provider = await startMockProvider({ script: options.script, ...(options.provider ?? {}) });
    const ghostName = options.ghostName ?? "casper";
    const ghostHome = seedGhost(ghostsRoot, {
      name: ghostName,
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const homeOperations = new HomeOperationCoordinator(registry);
    host = new SessionHost({
      registry,
      offline: true,
      title: { enabled: false },
      greeting: { enabled: false },
    });
    const mcp = new McpCatalog({ registry, homeOperations });
    listening = await startDaemonServer({
      registry,
      host,
      homeOperations,
      mcp,
      port: 0,
      apiToken: API_TOKEN,
      relay: null,
    });

    let closing: Promise<void> | null = null;
    const request = async <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<JsonResponse<T>> => {
      assertLocalPath(path);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const result = await within(new Promise<JsonResponse<T>>((resolve, reject) => {
        const outgoing = httpRequest({
          host: "127.0.0.1",
          port: listening?.port,
          path,
          method,
          agent: false,
          headers: {
            authorization: `Bearer ${API_TOKEN}`,
            accept: "application/json",
            connection: "close",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        }, (response) => {
          response.setEncoding("utf8");
          let raw = "";
          response.on("data", (chunk: string) => {
            raw += chunk;
          });
          response.once("end", () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: (raw ? JSON.parse(raw) : null) as T,
                raw,
              });
            } catch (error) {
              reject(error);
            }
          });
          response.once("error", reject);
        });
        outgoing.once("error", reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
      }), `${method} ${path}`);
      return result;
    };

    const startTurn = async (sessionId: string, prompt: string): Promise<RealSseClient> => {
      const path = `/api/ghosts/${encodeURIComponent(ghostName)}/messages`;
      const payload = JSON.stringify({
        model: `ghost/${ghostName}`,
        context: { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
        options: { sessionId },
      });
      return within(new Promise<RealSseClient>((resolve, reject) => {
        const outgoing = httpRequest({
          host: "127.0.0.1",
          port: listening?.port,
          path,
          method: "POST",
          agent: false,
          headers: {
            authorization: `Bearer ${API_TOKEN}`,
            accept: "text/event-stream",
            connection: "close",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        }, (response) => {
          let client!: RealSseClient;
          client = new RealSseClient(response, () => clients.delete(client));
          clients.add(client);
          resolve(client);
        });
        outgoing.once("error", reject);
        outgoing.end(payload);
      }), `SSE response headers for ${sessionId}`);
    };

    return {
      tempRoot,
      ghostsRoot,
      ghostHome,
      ghostName,
      port: listening.port,
      provider,
      host,
      request,
      startTurn,
      close() {
        if (closing) return closing;
        closing = (async () => {
          try {
            for (const client of clients) client.disconnect();
            await listening?.close();
            await host?.disposeAll();
            await provider?.close();
          } finally {
            restoreEnvironment(environment);
            rmSync(tempRoot, { recursive: true, force: true });
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    for (const client of clients) client.disconnect();
    await listening?.close().catch(() => {});
    await host?.disposeAll().catch(() => {});
    await provider?.close().catch(() => {});
    restoreEnvironment(environment);
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
