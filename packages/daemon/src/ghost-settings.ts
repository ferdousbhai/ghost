/**
 * Load the owner-visible settings file without handing OMP a ghost-home
 * convention to discover.
 *
 * OMP's Settings parser and schema remain useful, but its ordinary cwd and
 * agent-directory loaders would also consult `.omp/`, `.pi/config.yml`, and
 * third-party project config. Start it against an empty machine-state scope,
 * add only Ghost's explicit `settings.yml`, then re-scope path-sensitive
 * values to the home. `loadReadOnly` instances do not rediscover project files
 * during that re-scope.
 */
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
    ...(existsSync(paths.settingsFile) ? { configFiles: [paths.settingsFile] } : {}),
    overrides,
  });
  await settings.reloadForCwd(paths.home);
  return settings;
}
