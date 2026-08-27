import { request } from "node:http";

/** Run a real loopback request without Bun's process-wide socket pool. */
export async function fetchNoReuse(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const headers = new Headers(init.headers);
  const body = requestBody(init.body);
  if (body !== undefined && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = () => {};
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      settle();
    };
    const fail = (error: Error): void => finish(() => reject(error));
    const succeed = (response: Response): void => finish(() => resolve(response));
    const req = request(url, {
      agent: false,
      headers: Object.fromEntries(headers.entries()),
      method: init.method ?? "GET",
    }, (response) => {
      const chunks: Buffer[] = [];
      let ended = false;
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      response.once("error", fail);
      response.once("aborted", () => fail(new Error("Loopback response was aborted.")));
      response.once("close", () => {
        if (!ended) fail(new Error("Loopback response closed before completion."));
      });
      response.once("end", () => {
        ended = true;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, String(value));
          }
        }
        const status = response.statusCode ?? 500;
        succeed(new Response(
          [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
          { headers: responseHeaders, status, statusText: response.statusMessage },
        ));
      });
    });
    req.once("error", fail);
    if (init.signal) {
      const signal = init.signal;
      const abort = () => {
        const reason = signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("Loopback request was aborted."), { name: "AbortError" });
        req.destroy();
        fail(reason);
      };
      removeAbortListener = () => signal.removeEventListener("abort", abort);
      if (init.signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    if (!settled) {
      if (body !== undefined) req.write(body);
      req.end();
    }
  });
}

function requestBody(body: RequestInit["body"]): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("fetchNoReuse only accepts buffered request bodies");
}
