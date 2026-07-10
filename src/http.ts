#!/usr/bin/env node
import { createMcpHttpServer } from "./http-server.js";

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

// Bind loopback by default; exposing the key-bearer edge to a network is an
// explicit decision (LBB_MCP_HOST=0.0.0.0) that should sit behind your own
// auth/edge. When bound to loopback, DNS-rebinding protection defaults to
// loopback host names; override with LBB_MCP_ALLOWED_HOSTS /
// LBB_MCP_ALLOWED_ORIGINS (comma-separated) when fronting it deliberately.
const host = process.env.LBB_MCP_HOST ?? "127.0.0.1";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const isLoopback = LOOPBACK_HOSTS.includes(host);

function csv(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

const mcpPath = process.env.LBB_MCP_PATH ?? "/mcp";
const httpServer = createMcpHttpServer({
  baseUrl: process.env.LBB_BASE_URL ?? "https://db.eu.littlebigbrain.com",
  mcpPath,
  allowedHosts:
    csv(process.env.LBB_MCP_ALLOWED_HOSTS) ??
    (isLoopback ? LOOPBACK_HOSTS : undefined),
  allowedOrigins: csv(process.env.LBB_MCP_ALLOWED_ORIGINS),
  onError: (error) => console.error(error),
});

httpServer.listen(port, host, () => {
  console.error(
    `lbb MCP (streamable-http) listening on ${host}:${port}${mcpPath}`,
  );
});
