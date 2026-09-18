import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LbbClient } from "@littlebigbrain/client";
import { registerLbbTools } from "./tools.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/** Build an MCP server exposing the little big brain tool belt, bound to one client. */
export function buildLbbServer(client: LbbClient): McpServer {
  const server = new McpServer({ name: "lbb", version });
  registerLbbTools(server, client);
  return server;
}
