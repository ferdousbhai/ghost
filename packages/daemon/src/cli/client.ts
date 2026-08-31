import { defaultApiTokenPath, readApiToken } from "../api-token.js";
import { loadConfig } from "../config.js";
import { SSE_KEEPALIVE_INTERVAL_MS } from "../pi-messages.js";
import { describeErrorBody } from "./output.js";
import type { CliRuntime } from "./types.js";

/**
 * A control request is a small JSON round-trip the daemon answers immediately,
 * so a short cap catches a daemon that is gone rather than one that is busy.
 */
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
/**
 * An accepted event stream flushes its headers immediately. Allow one
 * keepalive interval for admission and that opening response; the timer is
 * cleared before the turn runs and therefore never caps working time.
 */
const STREAM_OPEN_TIMEOUT_MS = SSE_KEEPALIVE_INTERVAL_MS;

export class CliError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
    this.name = "CliError";
  }
}

export const EXIT_CODE = {
  success: 0,
  failure: 1,
  usage: 2,
  unreachable: 3,
  unauthorized: 4,
  notFound: 5,
  conflict: 6,
} as const;

export const EXIT_CODES = [
  { code: EXIT_CODE.success, meaning: "success" },
  { code: EXIT_CODE.failure, meaning: "turn or action failed" },
  { code: EXIT_CODE.usage, meaning: "usage error" },
  { code: EXIT_CODE.unreachable, meaning: "daemon unreachable" },
  { code: EXIT_CODE.unauthorized, meaning: "unauthorized" },
  { code: EXIT_CODE.notFound, meaning: "not found" },
  { code: EXIT_CODE.conflict, meaning: "busy or conflict" },
] as const;

export function notFound(what: string): CliError {
  return new CliError(EXIT_CODE.notFound, `${what} was not found`);
}

export interface CliResponse<T = unknown> {
  status: number;
  body: T;
}

function networkError(error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(EXIT_CODE.unreachable, `cannot reach ghostd: ${message}`);
}

function statusError(status: number, body: unknown, tokenPath: string): CliError {
  if (status === 401) {
    return new CliError(
      EXIT_CODE.unauthorized,
      `unauthorized; run \`ghostd api-token\` as the machine owner (token file: ${tokenPath})`,
    );
  }
  const message = describeErrorBody(body, `daemon returned HTTP ${status}`);
  if (status === 404) return new CliError(EXIT_CODE.notFound, message);
  if (status === 409) return new CliError(EXIT_CODE.conflict, message);
  return new CliError(EXIT_CODE.failure, message);
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly tokenPath: string;
  readonly #runtime: CliRuntime;
  #tokenValue: string | undefined;

  constructor(runtime: CliRuntime) {
    this.#runtime = runtime;
    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig({ env: runtime.env, home: runtime.home });
    } catch (error) {
      throw new CliError(EXIT_CODE.usage, `invalid daemon configuration: ${(error as Error).message}`);
    }
    const host = config.host === "::1" ? "[::1]" : config.host;
    this.baseUrl = `http://${host}:${config.port}`;
    this.tokenPath = defaultApiTokenPath(runtime.env, runtime.home);
    this.#tokenValue = readApiToken({ env: runtime.env, home: runtime.home });
  }

  async #fetch(
    path: string,
    init: RequestInit,
    retry = true,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "application/json");
    if (this.#tokenValue) headers.set("authorization", `Bearer ${this.#tokenValue}`);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout.signal])
      : timeout.signal;
    let response: Response;
    try {
      response = await this.#runtime.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal,
      });
    } catch (error) {
      throw networkError(error);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 && retry) {
      await response.body?.cancel().catch(() => undefined);
      this.#tokenValue = readApiToken({ env: this.#runtime.env, home: this.#runtime.home });
      return this.#fetch(path, init, false, timeoutMs);
    }
    return response;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<CliResponse<T>> {
    const response = await this.#fetch(path, {
      method,
      ...(body === undefined ? {} : {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    });
    const parsed = await responseBody(response);
    if (!response.ok) throw statusError(response.status, parsed, this.tokenPath);
    return { status: response.status, body: parsed as T };
  }

  async optional<T = unknown>(method: string, path: string): Promise<CliResponse<T> | null> {
    try {
      return await this.request<T>(method, path);
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT_CODE.notFound) return null;
      throw error;
    }
  }

  async stream(
    path: string,
    body: unknown | undefined,
    onEvent: (event: unknown) => boolean | void | Promise<boolean | void>,
    options: { method?: "GET" | "POST"; signal?: AbortSignal } = {},
  ): Promise<void> {
    const method = options.method ?? (body === undefined ? "GET" : "POST");
    const response = await this.#fetch(path, {
      method,
      ...(options.signal ? { signal: options.signal } : {}),
      headers: {
        accept: "text/event-stream",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, true, STREAM_OPEN_TIMEOUT_MS);
    if (!response.ok) {
      const parsed = await responseBody(response);
      throw statusError(response.status, parsed, this.tokenPath);
    }
    if (!response.body) throw new CliError(EXIT_CODE.failure, "daemon returned an empty event stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const consume = async (complete = false): Promise<void> => {
      const normalized = pending.replace(/\r\n/g, "\n");
      const frames = normalized.split("\n\n");
      pending = complete ? "" : (frames.pop() ?? "");
      for (const frame of frames) {
        const data = frame.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          const keepGoing = await onEvent(JSON.parse(data) as unknown);
          if (keepGoing === false) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        } catch (error) {
          if (error instanceof SyntaxError) throw new CliError(EXIT_CODE.failure, "daemon sent invalid SSE JSON");
          throw error;
        }
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        await consume(done);
        if (done) break;
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw networkError(error);
    } finally {
      reader.releaseLock();
    }
  }
}
