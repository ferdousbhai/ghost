/** Load only the owner-visible settings file for one Ghost. */
import { existsSync } from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { ghostPaths } from "./ghosts.js";

export async function loadGhostSettings(
  homeDir: string,
  overrides: Partial<Record<SettingPath, unknown>> = {},
): Promise<Settings> {
  const paths = ghostPaths(homeDir);
  const settings = await Settings.loadReadOnly({
    cwd: paths.settingsRuntimeDir,
    agentDir: paths.settingsRuntimeDir,
    configFiles: existsSync(paths.settingsFile) ? [paths.settingsFile] : [],
    overrides,
  });
  await settings.reloadForCwd(paths.home);
  return settings;
}
