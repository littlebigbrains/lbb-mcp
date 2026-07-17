#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LbbClient } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";

const BASE_URL_HELP =
  "LBB_BASE_URL is required. Copy endpoint_url from your Little Big Brain stack's Connect page.";

/**
 * Local stdio entrypoint (`npx @littlebigbrain/mcp`). Reads the connection from the
 * environment and serves the little big brain tools over stdio, the transport every
 * editor (Claude Code, Cursor, Codex) supports.
 *
 *   LBB_BASE_URL  (required for tool calls; copy endpoint_url from the stack Connect page)
 *   LBB_API_KEY   stack API key (lbb_sk_live_…) or single-mode token
 *   LBB_GRAPH / LBB_BRANCH  (optional; server defaults to main/main)
 *
 * The base URL is required lazily, at the first tool invocation, not at
 * process start: MCP hosts launch servers to complete the initialize
 * handshake and list tools before the user has finished configuring them,
 * and a startup crash surfaces as an opaque "server failed to start" in
 * every editor. An unconfigured server therefore boots, handshakes, and
 * lists tools normally — and every tool call fails with the actionable
 * message above until LBB_BASE_URL is set. (There is deliberately no
 * localhost default: pointing production tool calls at 127.0.0.1 silently
 * was worse than failing loudly.)
 */
export function unconfiguredClient(): LbbClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        // Allow the runtime's duck-typing probes without exploding.
        if (property === "then" || typeof property === "symbol")
          return undefined;
        throw new Error(BASE_URL_HELP);
      },
    },
  ) as LbbClient;
}

async function main(): Promise<void> {
  const baseUrl = process.env.LBB_BASE_URL?.trim();
  if (!baseUrl) {
    console.error(
      `warning: ${BASE_URL_HELP} Tool calls will fail until it is set.`,
    );
  }
  const client = baseUrl
    ? new LbbClient({
        baseUrl,
        apiKey: process.env.LBB_API_KEY,
        graph: process.env.LBB_GRAPH,
        branch: process.env.LBB_BRANCH,
      })
    : unconfiguredClient();
  const server = buildLbbServer(client);
  await server.connect(new StdioServerTransport());
}

// Only start the server when executed as the bin entrypoint — importing this
// module (e.g. the unconfiguredClient unit tests) must not attach a stdio
// transport to the host process, which would hold its stdin open forever.
const invokedAsBin =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsBin) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
