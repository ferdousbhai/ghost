import { pathToFileURL } from "node:url";

/** Whether this module is the process entry point, so imports run nothing. */
export function isDirectInvocation(moduleUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(entryPath).href;
}
