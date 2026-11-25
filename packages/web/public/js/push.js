/**
 * Alerts on this device when a ghost finishes a turn: Web Push, sent by each
 * machine's ghostd itself. SummonGhost has no server to send them, so this
 * browser makes its own signing key and hands it, with its push subscription,
 * to each of the owner's machines over Tailscale. Nothing else gets either.
 */
import { api } from "./net.js";

const KEY = "summonghost.push.v1";

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Whether this browser can be alerted at all. On an iPhone that is only the app on the Home Screen. */
export const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** An iPhone or iPad in a browser tab, where alerts need the Home Screen app first. */
export const needsHomeScreen = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !supported() && !matchMedia("(display-mode: standalone)").matches;

function savedKey() {
  try {
    const key = JSON.parse(localStorage.getItem(KEY) || "null");
    return key && typeof key.d === "string" && typeof key.x === "string" && typeof key.y === "string" ? key : null;
  } catch {
    return null;
  }
}

/** The signing key's public half as push wants it: an uncompressed point. */
const publicPoint = (key) => Uint8Array.from([4, ...unb64(key.x), ...unb64(key.y)]);

/** This device's subscription and key, or null when alerts are off here. */
async function current() {
  if (!supported() || Notification.permission !== "granted") return null;
  const key = savedKey();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!key || !subscription) return null;
  // A subscription made with a key this browser no longer has can never be signed for.
  const bound = subscription.options.applicationServerKey;
  if (!bound || b64(bound) !== b64(publicPoint(key))) return null;
  return { subscription, key };
}

/** "on", "off", "blocked" (the browser refuses alerts from this site), or "unsupported". */
export async function state() {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return (await current().catch(() => null)) ? "on" : "off";
}

const body = ({ subscription, key }) => {
  const keys = subscription.toJSON().keys;
  return { endpoint: subscription.endpoint, p256dh: keys.p256dh, auth: keys.auth, vapidKey: key.d };
};

/** Tell one machine about this device, when alerts are on here. A machine added later is told the same way. */
export async function sync(host) {
  const mine = await current().catch(() => null);
  if (mine) await api(host, "/push/subscription", { method: "PUT", body: body(mine) });
}

/**
 * Turn alerts on for this device on each of `hosts`, then have the first
 * machine that took it send one. Returns the hosts that took it and what the
 * test said; throws when the browser refuses.
 */
export async function enable(hosts) {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("This browser is blocking alerts from summonghost.com.");
  const registration = await navigator.serviceWorker.ready;
  let key = savedKey();
  const stale = await registration.pushManager.getSubscription();
  if (stale && (!key || b64(stale.options.applicationServerKey || []) !== b64(publicPoint(key)))) await stale.unsubscribe();
  if (!key) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const { d, x, y } = await crypto.subtle.exportKey("jwk", pair.privateKey);
    key = { d, x, y };
    localStorage.setItem(KEY, JSON.stringify(key));
  }
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicPoint(key) });
  const mine = { subscription, key };
  const taken = [];
  for (const host of hosts) {
    try {
      await api(host, "/push/subscription", { method: "PUT", body: body(mine) });
      taken.push(host);
    } catch {}
  }
  let test = null;
  if (taken.length) test = await api(taken[0], "/push/test", { method: "POST", body: { endpoint: subscription.endpoint } }).catch(() => null);
  return { taken, test };
}

/** Turn alerts off for this device, on every machine that can be reached. */
export async function disable(hosts) {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await Promise.all(hosts.map((host) => api(host, "/push/subscription", { method: "DELETE", body: { endpoint: subscription.endpoint } }).catch(() => {})));
    await subscription.unsubscribe();
  }
  try { localStorage.removeItem(KEY); } catch {}
}
