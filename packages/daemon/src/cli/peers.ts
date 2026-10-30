import type { Peer } from "../peers.js";
import { ArgsError, flagString } from "./args.js";
import { resolveGhost } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

interface PeerListing {
  peers: Peer[];
  invites?: { name: string; ghost: string; expiresAt: string }[];
  keyExpiry?: string | null;
}

interface PeerCheck {
  peers: { name: string; sent: number; received: number; turn: boolean; unreachable?: true; refused?: true }[];
  keyExpiry: string | null;
}

function keyLine(keyExpiry: string | null | undefined): string {
  if (keyExpiry === undefined) return "";
  return keyExpiry === null
    ? "This machine's Tailscale key does not expire.\n"
    : `This machine's Tailscale key expires ${keyExpiry.slice(0, 10)}; peers cannot reach it after that until you sign in again.\n`;
}

function listing(body: PeerListing): string {
  const peers = body.peers.length > 0
    ? `${table(body.peers.map((peer) => [peer.name, peer.login, peer.url ?? "(they check in)", peer.ghost]), ["NAME", "LOGIN", "ADDRESS", "GHOST"])}\n`
    : "No peers.\n";
  const invites = (body.invites ?? []).length > 0
    ? `\nPending invites:\n${table((body.invites ?? []).map((invite) => [invite.name, invite.ghost, invite.expiresAt.slice(0, 10)]), ["NAME", "GHOST", "EXPIRES"])}\n`
    : "";
  return `${peers}${invites}${keyLine(body.keyExpiry)}`;
}

/** `ghost peers [list|invite|accept|check|add|rm]` over the owner's peers. */
export async function peersCommand(ctx: CliContext): Promise<number> {
  const [action = "list", ...rest] = ctx.parsed.positionals;
  const none = (verb: string) => {
    if (rest.length > 0) throw new ArgsError(`ghost peers ${verb} takes no further arguments`);
  };
  switch (action) {
    case "list": {
      none("list");
      emit(ctx, await ctx.client.request<PeerListing>("GET", "/api/peers"), listing);
      return 0;
    }
    case "invite": {
      const [name] = rest;
      const share = flagString(ctx.parsed, "share");
      if (!name || rest.length > 1 || !share) throw new ArgsError("ghost peers invite needs <name> --share <Tailscale share link>");
      const from = flagString(ctx.parsed, "from");
      const body = await ctx.client.request<{ invite: string; keyExpiry: string | null }>("POST", "/api/peers/invites", {
        name, share, ghost: await resolveGhost(ctx), ...(from ? { from } : {}),
      });
      emit(ctx, body, (result) => `${result.invite}\n\nSend this to ${name}; their ghost pairs with it once (within 7 days).\n${keyLine(result.keyExpiry)}`);
      return 0;
    }
    case "accept": {
      const [invite] = rest;
      if (!invite || rest.length > 1) throw new ArgsError("ghost peers accept needs the ghost-peer: invite");
      const name = flagString(ctx.parsed, "name");
      const body = await ctx.client.request<PeerListing>("POST", "/api/peers/accept", { invite, ghost: await resolveGhost(ctx), ...(name ? { name } : {}) });
      emit(ctx, body, listing);
      return 0;
    }
    case "check": {
      none("check");
      const body = await ctx.client.request<PeerCheck>("POST", "/api/peers/check");
      emit(ctx, body, (result) => `${result.peers.map((peer) => {
        if (peer.refused) return `${peer.name}: refused (they no longer list you)`;
        const moved = `${peer.sent} sent, ${peer.received} received${peer.turn ? ", new messages handed to your ghost" : ""}`;
        return `${peer.name}: ${peer.unreachable ? `unreachable (asleep or away); ${moved}` : moved}`;
      }).join("\n") || "No peers."}\n${keyLine(result.keyExpiry)}`);
      return 0;
    }
    case "add": {
      const [name, login, url] = rest;
      if (!name || !login || !url || rest.length > 3) throw new ArgsError("ghost peers add needs <name> <login> <url>");
      // Their messages go to the ghost named by -g, $GHOST, or the default.
      emit(ctx, await ctx.client.request<PeerListing>("POST", "/api/peers", { name, login, url, ghost: await resolveGhost(ctx) }), listing);
      return 0;
    }
    case "rm": {
      const [name] = rest;
      if (!name || rest.length > 1) throw new ArgsError("ghost peers rm needs exactly one peer or invite name");
      emit(ctx, await ctx.client.request<PeerListing>("DELETE", `/api/peers/${encodeURIComponent(name)}`), listing);
      return 0;
    }
    default:
      throw new ArgsError(`ghost peers does not know "${action}"; use list, invite, accept, check, add, or rm.`);
  }
}

/** `ghost message <peer> <text>`: queued for them, delivered now if their Ghost answers. */
export async function messageCommand(ctx: CliContext): Promise<number> {
  const [name = "", text = ""] = ctx.parsed.positionals;
  if (!text.trim()) throw new ArgsError("ghost message needs <peer> <text>");
  const body = await ctx.client.request<{ delivered: boolean }>("POST", `/api/peers/${encodeURIComponent(name)}/messages`, { text });
  emit(ctx, body, (result) => result.delivered
    ? `Delivered to ${name}.\n`
    : `Waiting for ${name}; it goes when the two machines next check in.\n`);
  return 0;
}
