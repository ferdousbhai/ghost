/**
 * The machine list, kept in this browser only. Storage can be missing or
 * refuse (private windows, blocked site data); the app then works for the
 * visit and forgets when closed.
 */
const KEY = "summonghost.machines.v1";

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

/** `{ machines, forgotten }`: the saved machines, and hosts removed by hand that discovery must not bring back. */
export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const machines = (Array.isArray(saved.machines) ? saved.machines : [])
      .filter((m) => m && typeof m.host === "string")
      .map((m) => ({
        host: m.host,
        role: typeof m.role === "string" ? m.role : null,
        ghost: typeof m.ghost === "string" ? m.ghost : null,
        seen: typeof m.seen === "number" ? m.seen : 0,
      }));
    return { machines, forgotten: strings(saved.forgotten) };
  } catch {
    return { machines: [], forgotten: [] };
  }
}

/** False when this browser would not keep it. */
export function save(machines, forgotten) {
  try {
    const kept = machines.map(({ host, role, ghost, seen }) => ({ host, role, ghost, seen }));
    localStorage.setItem(KEY, JSON.stringify({ machines: kept, forgotten }));
    return true;
  } catch {
    return false;
  }
}
