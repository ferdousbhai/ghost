import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the Claude Code SDK keeps its own files, which is outside the ghost
 * home and therefore outside `session-files.ts`. Ghost only reads here.
 */

/**
 * The SDK's session transcript for a resume id, when it exists. The SDK
 * persists under `$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<id>.jsonl`; the
 * directory name encoding is the SDK's, so the file is located by id.
 */
export function claudeSdkTranscriptPath(
  sessionId: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string | undefined {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(sessionId)) return undefined;
  const projects = join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
    "projects",
  );
  let directories: string[];
  try {
    directories = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const candidate = join(projects, directory, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
