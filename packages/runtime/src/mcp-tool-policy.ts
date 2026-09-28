/** The model-facing portion of an MCP result. Metadata and server errors stay out. */
export function formatMcpContent(content: readonly unknown[]): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  let text = "";
  const flush = (): void => {
    if (!text) return;
    blocks.push({ type: "text", text });
    text = "";
  };
  const append = (value: string): void => {
    text += text ? `\n\n${value}` : value;
  };
  for (const item of content) {
    if (item === null || typeof item !== "object" || !("type" in item)) continue;
    if (item.type === "text" && "text" in item && typeof item.text === "string") append(item.text);
    else if (item.type === "image" && "data" in item && "mimeType" in item
      && typeof item.data === "string" && typeof item.mimeType === "string") {
      flush();
      blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item.type === "resource" && "resource" in item && item.resource !== null
      && typeof item.resource === "object" && "uri" in item.resource && typeof item.resource.uri === "string") {
      const body = "text" in item.resource && typeof item.resource.text === "string" ? item.resource.text : undefined;
      append(body ? `[Resource: ${item.resource.uri}]\n${body}` : `[Resource: ${item.resource.uri}]`);
    }
  }
  flush();
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

export type McpErrorCode = "mcp_connection_failed" | "mcp_tool_load_failed" | "mcp_tool_call_failed";
export function mcpConnectionErrorCode(toolLoadFailed: boolean): McpErrorCode {
  return toolLoadFailed ? "mcp_tool_load_failed" : "mcp_connection_failed";
}
export function mcpToolCallErrorCode(): McpErrorCode { return "mcp_tool_call_failed"; }
