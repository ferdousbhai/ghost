/**
 * How a ghost's `models.json` is projected into the file the hosting runtime
 * reads: the ghost's provider entries as pi's models.json shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GhostModelsFile } from "./models.js";
import { writePrivateJsonAtomicSync } from "./private-file.js";

export interface ModelsViewOptions {
  /** Treat an omitted key on a custom endpoint with models as keyless (`auth: "none"`). */
  legacyKeylessAuth?: boolean;
}

/** The `models.json` a runtime reads: the ghost's provider entries without Ghost's display names. */
export function modelsDocument(
  models: GhostModelsFile,
  options: ModelsViewOptions = {},
): { providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  for (const [provider, raw] of Object.entries(models.providers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const { name: _ghostDisplayName, ...config } = raw;
    if (
      options.legacyKeylessAuth
      && Array.isArray(config.models)
      && config.models.length > 0
      && config.apiKey === undefined
      && config.auth === undefined
    ) {
      config.auth = "none";
    }
    providers[provider] = config;
  }
  return { providers };
}

/** Write the projected view under `agentDir` when it changed; returns its path. */
export function syncModelsView(
  models: GhostModelsFile,
  agentDir: string,
  filename: string,
  options: ModelsViewOptions = {},
): string {
  const target = join(agentDir, filename);
  const document = modelsDocument(models, options);
  const rendered = `${JSON.stringify(document, null, 2)}\n`;
  if (!existsSync(target) || readFileSync(target, "utf8") !== rendered) {
    writePrivateJsonAtomicSync(target, document);
  }
  return target;
}
