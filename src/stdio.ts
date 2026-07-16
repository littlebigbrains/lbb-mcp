#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LbbClient } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";

/**
 * Local stdio entrypoint (`npx @littlebigbrain/mcp`). Reads the connection from the
 * environment and serves the little big brain tools over stdio, the transport every
 * editor (Claude Code, Cursor, Codex) supports.
 *
 *   LBB_BASE_URL  (required; copy endpoint_url from the stack Connect page)
 *   LBB_API_KEY   stack API key (lbb_sk_live_…) or single-mode token
 *   LBB_GRAPH / LBB_BRANCH  (optional; server defaults to main/main)
 */
async function main(): Promise<void> {
  const baseUrl = process.env.LBB_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "LBB_BASE_URL is required. Copy endpoint_url from your Little Big Brain stack's Connect page.",
    );
  }
  const client = new LbbClient({
    baseUrl,
    apiKey: process.env.LBB_API_KEY,
    graph: process.env.LBB_GRAPH,
    branch: process.env.LBB_BRANCH,
  });
  const server = buildLbbServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
