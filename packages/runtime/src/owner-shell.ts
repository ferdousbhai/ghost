export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  timestamp: number;
  excludeFromContext?: boolean;
}

export function bashExecutionToText(message: BashExecutionMessage): string {
  const status = message.cancelled
    ? "[cancelled]"
    : message.exitCode === undefined || message.exitCode === 0
      ? ""
      : `[exit ${message.exitCode}]`;
  const output = message.truncated ? `${message.output}\n[output truncated]` : message.output;
  return [`$ ${message.command}`, output.trimEnd(), status].filter(Boolean).join("\n");
}

export interface UserBashCommand {
  command: string;
  excludeFromContext: boolean;
}

export function parseUserBashCommand(text: string): UserBashCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return null;
  const excludeFromContext = trimmed.startsWith("!!");
  const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
  return { command, excludeFromContext };
}

