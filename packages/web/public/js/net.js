/**
 * Talking to one machine's ghostd over Tailscale, and saying in plain words
 * why that failed. The browser carries no token and no cookie: Tailscale
 * Serve tells ghostd who is calling.
 */

/** A failure the person can act on; `kind` picks how the app shows it. */
export class MachineError extends Error {
  constructor(kind, message, status = 0, code = "") {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** `host[:port]` from whatever was typed or linked: a URL, a bare name, a trailing dot. */
export function normalizeHost(input, tailnet = "") {
  let value = String(input || "").trim().toLowerCase();
  value = value.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "");
  const [rawName, port = ""] = value.split(":");
  let name = (rawName || "").replace(/\.$/, "");
  if (!name || !/^[a-z0-9.-]+$/.test(name) || (port && !/^\d{1,5}$/.test(port))) return null;
  if (!name.includes(".") && tailnet) name += "." + tailnet;
  if (!name.endsWith(".ts.net")) return null;
  return port && port !== "443" ? name + ":" + port : name;
}

/** The machine's own name: the first label of its tailnet address. */
export const shortName = (host) => host.split(".")[0];
/** The name shown for a machine: its own name, with the port when it isn't the usual one. */
export const label = (host) => shortName(host) + (host.includes(":") ? ":" + host.split(":")[1] : "");
/** The tailnet a host is on, e.g. `tail1234.ts.net`. */
export const tailnetOf = (host) => host.split(":")[0].split(".").slice(1).join(".");

export const base = (host) => "https://" + host;

/** Chrome's permission for a public site to reach private addresses, such as tailnet ones. */
async function localNetworkPermission() {
  try {
    return (await navigator.permissions.query({ name: "local-network" })).state;
  } catch {
    return null;
  }
}

/**
 * Why a fetch to `host` never got an answer. A browser hides the reason, so
 * it is found by elimination: the local-network permission, then a no-cors
 * request that succeeds when the machine answers without allowing this app.
 */
export async function diagnose(host) {
  const name = shortName(host);
  const permission = await localNetworkPermission();
  if (permission === "denied") {
    return new MachineError(
      "local-network",
      "This browser is blocking summonghost.com from reaching your machines. In the site settings for summonghost.com (the icon left of the address), set Local network access to Allow, then reload.",
    );
  }
  try {
    await fetch(base(host) + "/api/remote/whoami", { mode: "no-cors", cache: "no-store", credentials: "omit" });
    return new MachineError(
      "outdated",
      `Ghost on ${name} doesn't let this app in. Update Ghost on ${name}, or check that its remote.apps setting includes https://summonghost.com.`,
    );
  } catch {}
  if (permission === "prompt") {
    return new MachineError(
      "unreachable",
      `Can't reach ${name}. If your browser asks to let summonghost.com reach devices on your network, choose Allow. Otherwise check that Tailscale is connected on this device.`,
    );
  }
  return new MachineError(
    "unreachable",
    `Can't reach ${name}. Check that Tailscale is connected on this device. If it is, ${name} may be off or asleep, or it is not served to your tailnet (ghost status on that machine says how).`,
  );
}

function refusal(host, status, error) {
  const name = shortName(host);
  const code = error?.code || "";
  if (status === 401) {
    return new MachineError(
      "not-owner",
      `${name} only answers its owner. This device is signed in to Tailscale as someone else.`,
      status,
      code,
    );
  }
  if (code === "forbidden_origin") {
    return new MachineError("outdated", `Ghost on ${name} has this app turned off (remote.apps).`, status, code);
  }
  return new MachineError("http", error?.message || `${name} answered ${status}.`, status, code);
}

/** One raw request to a machine; network failures come back explained. */
export async function request(host, path, init = {}) {
  let response;
  try {
    response = await fetch(base(host) + "/api" + path, { cache: "no-store", credentials: "omit", ...init });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw await diagnose(host);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw refusal(host, response.status, body.error);
  }
  return response;
}

/** A JSON request; a body object is sent as JSON. */
export async function api(host, path, { method = "GET", body, signal } = {}) {
  const init = { method, signal };
  if (body !== undefined) {
    if (body instanceof Blob) {
      init.body = body;
      init.headers = { "content-type": body.type || "image/jpeg" };
    } else {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
  }
  return (await request(host, path, init)).json();
}

export const seg = (value) => encodeURIComponent(value);
