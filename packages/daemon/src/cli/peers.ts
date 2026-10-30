import type { Peer } from "../peers.js";
import { ArgsError } from "./args.js";
import { resolveGhost } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

function peerTable(peers: readonly Peer[]): string {
  return peers.length > 0
    ? `${table(peers.map((peer) => [peer.name, peer.login, peer.url, peer.ghost]), ["NAME", "LOGIN", "URL", "GHOST"])}\n`
    : "No peers.\n";
}

/** `ghost peers [list|add <name> <login> <url>|rm <name>]` over the owner's `remote.peers`. */
export async function peersCommand(ctx: CliContext): Promise<number> {
  const [action = "list", ...rest] = ctx.parsed.positionals;
  let body: { peers: Peer[] };
  switch (action) {
    case "list":
      if (rest.length > 0) throw new ArgsError("ghost peers list takes no further arguments");
      body = await ctx.client.request<{ peers: Peer[] }>("GET", "/api/peers");
      break;
    case "add": {
      const [name, login, url] = rest;
      if (!name || !login || !url || rest.length > 3) throw new ArgsError("ghost peers add needs <name> <login> <url>");
      // Their messages go to the ghost named by -g, $GHOST, or the default.
      body = await ctx.client.request<{ peers: Peer[] }>("POST", "/api/peers", { name, login, url, ghost: await resolveGhost(ctx) });
      break;
    }
    case "rm": {
      const [name] = rest;
      if (!name || rest.length > 1) throw new ArgsError("ghost peers rm needs exactly one peer name");
      body = await ctx.client.request<{ peers: Peer[] }>("DELETE", `/api/peers/${encodeURIComponent(name)}`);
      break;
    }
    default:
      throw new ArgsError(`ghost peers does not know "${action}"; use list, add, or rm.`);
  }
  emit(ctx, body, (result) => peerTable(result.peers));
  return 0;
}

/** `ghost message <peer> <text>`: delivered to their Ghost, logged in the conversation with them. */
export async function messageCommand(ctx: CliContext): Promise<number> {
  const [name = "", text = ""] = ctx.parsed.positionals;
  if (!text.trim()) throw new ArgsError("ghost message needs <peer> <text>");
  const body = await ctx.client.request<{ delivered: boolean; duplicate: boolean }>(
    "POST",
    `/api/peers/${encodeURIComponent(name)}/messages`,
    { text },
  );
  emit(ctx, body, () => `Delivered to ${name}.\n`);
  return 0;
}
