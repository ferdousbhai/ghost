/** Bounded, read-only desktop observation shared by local and hosted adapters. */
export const MAX_DESKTOP_STATE_ITEMS = 40;
export const MAX_DESKTOP_STATE_WINDOWS = 40;
export const MAX_DESKTOP_STATE_TITLE = 80;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function truncate(value: unknown, max = MAX_DESKTOP_STATE_TITLE): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function workspaceName(client: Record<string, unknown>): string {
  const workspace = asRecord(client["workspace"]);
  const name = workspace?.["name"];
  if (typeof name === "string") return name;
  const id = workspace?.["id"];
  return typeof id === "number" ? String(id) : "";
}

export interface DesktopState {
  readonly activeWindow: { address: string; class: string; title: string; workspace: string } | null;
  readonly workspaces: ReadonlyArray<{ id: number | string; name: string; windows: number; monitor: string }>;
  readonly windows: ReadonlyArray<{ address: string; class: string; title: string; workspace: string; focused: boolean }>;
  readonly monitors: ReadonlyArray<{ name: string; focused: boolean; resolution?: string }>;
  readonly omitted: number;
  readonly workspacesOmitted: number;
  readonly monitorsOmitted: number;
}

/** Project Hyprland's large, untrusted state JSON into the model's fixed view. */
export function condenseDesktopState(
  clients: unknown, workspaces: unknown, activeWindow: unknown, monitors: unknown = [],
): DesktopState {
  const active = asRecord(activeWindow);
  const activeAddressRaw = typeof active?.["address"] === "string" ? active["address"] : null;
  const activeAddress = activeAddressRaw === null ? null : truncate(activeAddressRaw, 80);

  const clientList = Array.isArray(clients) ? clients : [];
  const windows = clientList
    .slice(0, MAX_DESKTOP_STATE_WINDOWS)
    .map(asRecord)
    .filter((client): client is Record<string, unknown> => client !== null)
    .map((client) => ({
      address: truncate(client["address"], 80), class: truncate(client["class"], 40),
      title: truncate(client["title"]), workspace: truncate(workspaceName(client), 40),
      focused: activeAddressRaw !== null && client["address"] === activeAddressRaw,
    }));

  const workspaceList = Array.isArray(workspaces) ? workspaces : [];
  const condensedWorkspaces = workspaceList
    .slice(0, MAX_DESKTOP_STATE_ITEMS)
    .map(asRecord)
    .filter((workspace): workspace is Record<string, unknown> => workspace !== null)
    .map((workspace) => {
      const id = finiteNumber(workspace["id"]);
      const windows = finiteNumber(workspace["windows"]);
      return {
        id: id ?? truncate(workspace["id"], 40), name: truncate(workspace["name"], 40),
        windows: windows === undefined ? 0 : Math.max(Math.floor(windows), 0),
        monitor: truncate(workspace["monitor"], 40),
      };
    });

  const monitorList = Array.isArray(monitors) ? monitors : [];
  const condensedMonitors = monitorList
    .slice(0, MAX_DESKTOP_STATE_ITEMS)
    .map(asRecord)
    .filter((monitor): monitor is Record<string, unknown> => monitor !== null)
    .map((monitor) => {
      const width = finiteNumber(monitor["width"]);
      const height = finiteNumber(monitor["height"]);
      const resolution = width !== undefined && height !== undefined ? `${width}x${height}` : undefined;
      return {
        name: truncate(monitor["name"], 40), focused: monitor["focused"] === true,
        ...(resolution ? { resolution } : {}),
      };
    })
    .filter((monitor) => monitor.name.length > 0);

  return {
    activeWindow: activeAddress ? {
      address: activeAddress, class: truncate(active?.["class"], 40),
      title: truncate(active?.["title"]), workspace: truncate(workspaceName(active ?? {}), 40),
    } : null,
    workspaces: condensedWorkspaces, windows, monitors: condensedMonitors,
    omitted: Math.max(clientList.length - windows.length, 0),
    workspacesOmitted: Math.max(workspaceList.length - condensedWorkspaces.length, 0),
    monitorsOmitted: Math.max(monitorList.length - condensedMonitors.length, 0),
  };
}
