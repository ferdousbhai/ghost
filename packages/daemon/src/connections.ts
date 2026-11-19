/**
 * What the owner can connect (CONTRACTS.md "Connections"): each product
 * behind the sources, whether it is installed and signed in, and the
 * product's own command that installs or connects it. Ghost only reports and
 * names the command; a client runs it in a terminal the owner sees, because
 * every one of them asks the owner something (a password, a sign-in, a code).
 */
import { which } from "./harnesses.js";
import { json, oneLine, runCommand, type SourceContext } from "./sources.js";

export interface ConnectionAction {
  readonly label: string;
  /** A shell command line for a terminal on the owner's desktop. */
  readonly command: string;
}

export interface Connection {
  readonly id: string;
  readonly label: string;
  /** What connecting it brings, in one line. */
  readonly brings: string;
  /** `missing`: the product is not installed. `disconnected`: installed, not signed in or set up. */
  readonly state: "missing" | "disconnected" | "connected";
  /** What is connected, or what is wrong, in one line; empty when there is nothing to say. */
  readonly detail: string;
  /** The next steps: installing when missing, else connecting or adding an account. */
  readonly actions: readonly ConnectionAction[];
}

interface Product {
  readonly id: string;
  readonly label: string;
  readonly brings: string;
  /** The command whose presence means installed. */
  readonly command: string;
  /** The product's published installer, which adds its signed package repository. */
  readonly installer: string;
  /** Whether it is connected, what to say about it, and what the owner can do next. */
  probe(context: SourceContext): Promise<{ connected: boolean; detail: string; actions: ConnectionAction[] }>;
}

const installer = (path: string) => `curl -fsSL https://ferdousbhai.com/${path}/install.sh | sudo bash`;

async function status(command: string, args: string[], context: SourceContext): Promise<Record<string, unknown> | null> {
  const data = json((await runCommand(command, args, context)).out);
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

/** The accounts a product's status lists, as their labels, the unreachable ones marked. */
function accounts(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((account) => {
    const row = account as { label?: unknown; name?: unknown; provider?: unknown; ok?: unknown };
    const name = oneLine(row.label ?? row.name ?? row.provider, 60);
    return row.ok === false ? `${name} (needs sign-in)` : name;
  }).filter(Boolean);
}

const PRODUCTS: readonly Product[] = [
  {
    id: "search", label: "Search", brings: "Finds your files, notes and messages by meaning, with a model that runs on this computer.",
    command: "recall", installer: installer("recall"),
    async probe(context) {
      const state = await status("recall", ["status"], context);
      const detail = state ? `${Number(state.searchable ?? 0)} of ${Number(state.files ?? 0)} files searchable` : "Its service is not running.";
      return { connected: state !== null, detail, actions: state ? [] : [{ label: "Set up", command: "recall setup" }] };
    },
  },
  {
    id: "icloud", label: "iCloud", brings: "Notes, Reminders, Photos and iCloud Drive, synced with your Apple devices.",
    command: "icloud-session", installer: installer("icloud"),
    async probe(context) {
      const session = await status("icloud-session", ["status", "--quiet"], context);
      const signedIn = session?.signed_in === true;
      return { connected: signedIn, detail: signedIn ? oneLine(session.apple_id, 120) : "", actions: signedIn ? [] : [{ label: "Sign in", command: "icloud-session sign-in" }] };
    },
  },
  {
    id: "mail", label: "Mail", brings: "Mail on your own domain through Cloudflare, with Gmail, iCloud Mail and HEY alongside.",
    command: "cloudmail", installer: installer("cloudmail"),
    async probe(context) {
      const state = await status("cloudmail", ["status", "--quiet"], context);
      const linked = accounts(state?.accounts);
      const own = typeof state?.api_url === "string" && state.api_url ? ["your own domain"] : [];
      const all = [...own, ...linked];
      // `cloudmail init` asks at the terminal: an invite, your own domains (moving one to Cloudflare only after it asks), and the accounts to link.
      return { connected: all.length > 0, detail: all.join(", "), actions: [{ label: all.length > 0 ? "Add mail" : "Set up mail", command: "cloudmail init" }] };
    },
  },
  {
    id: "calendar", label: "Calendar", brings: "iCloud, Google and HEY calendars as one agenda.",
    command: "cloud-calendar", installer: "curl -fsSL https://github.com/ferdousbhai/cloud-calendar/releases/latest/download/install.sh | sudo bash",
    async probe(context) {
      const linked = accounts((await status("cloud-calendar", ["status", "--quiet"], context))?.accounts);
      return {
        connected: linked.length > 0, detail: linked.join(", "),
        actions: ["iCloud", "Google", "HEY"].map((name) => ({ label: `Add ${name}`, command: `cloud-calendar account add ${name.toLowerCase()}` })),
      };
    },
  },
  {
    id: "contacts", label: "Contacts", brings: "Your iCloud and Google contacts.",
    command: "cloud-contacts", installer: installer("cloud-contacts"),
    async probe(context) {
      const rows = (await status("cloud-contacts", ["status", "--quiet"], context))?.accounts;
      const linked = accounts((Array.isArray(rows) ? rows : []).map((row) => ({ ...row as object, ok: (row as { signed_in?: unknown }).signed_in !== false })));
      return {
        connected: linked.length > 0, detail: linked.join(", "),
        actions: ["iCloud", "Google"].map((name) => ({ label: `Add ${name}`, command: `cloud-contacts account add ${name.toLowerCase()}` })),
      };
    },
  },
  {
    id: "whatsapp", label: "WhatsApp", brings: "Your chats, saved as folders on this computer.",
    command: "wacli", installer: installer("wacli"),
    async probe(context) {
      const data = (await status("wacli", ["doctor", "--json"], context))?.data as { accounts?: unknown } | undefined;
      const linked = (Array.isArray(data?.accounts) ? data.accounts : []).filter((account) => (account as { linked?: unknown }).linked === true)
        .map((account) => oneLine((account as { account?: unknown }).account, 60));
      // `wacli auth` shows the code to scan with the phone.
      return { connected: linked.length > 0, detail: linked.join(", "), actions: [{ label: linked.length > 0 ? "Link another" : "Link WhatsApp", command: "wacli auth" }] };
    },
  },
  {
    id: "lastbook", label: "Lastbook", brings: "An offline library of manuals and references Ghost can cite.",
    command: "lastbook", installer: installer("lastbook"),
    probe: async () => ({ connected: true, detail: "", actions: [] }),
  },
];

/** Every product, probed at once; one that fails to answer reads as not connected. */
export function listConnections(context: SourceContext): Promise<Connection[]> {
  return Promise.all(PRODUCTS.map(async (product): Promise<Connection> => {
    const base = { id: product.id, label: product.label, brings: product.brings };
    if (!which(product.command, context.env)) {
      return { ...base, state: "missing", detail: "", actions: [{ label: "Install", command: product.installer }] };
    }
    const { connected, detail, actions } = await product.probe(context);
    return { ...base, state: connected ? "connected" : "disconnected", detail, actions };
  }));
}
