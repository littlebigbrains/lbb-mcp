import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LbbClient } from "@littlebigbrain/client";
import { registerLbbTools } from "./tools.js";

/** Build an MCP server exposing the Little Big Brain tool belt, bound to one client. */
export function buildLbbServer(client: LbbClient): McpServer {
  const server = new McpServer({ name: "lbb", version: "0.1.0" });
  registerLbbTools(server, client);
  return server;
}
