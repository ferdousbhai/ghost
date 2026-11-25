/** The line for a running tool call: the call itself, never what came back. The model has two tools. */
export function toolCall(toolName, args) {
  if (toolName === "ask") return "Asking you";
  if (toolName !== "bash") return toolName || "tool";
  const command = args && typeof args.command === "string" ? args.command.replace(/\s+/gu, " ").trim() : "";
  return "$ " + (command.length > 1200 ? command.slice(0, 1199) + "…" : command || "…");
}
