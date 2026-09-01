import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Whether `candidate` resolves to `root` or a descendant of it. Both sides are
 * resolve()-normalized, so a `..` segment or relative spelling cannot slip a
 * path outside the root past the check.
 */
export function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
