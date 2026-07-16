# @littlebigbrain/mcp

Eleven task-shaped [MCP](https://modelcontextprotocol.io) tools that let Claude, Cursor, Codex, or any MCP client search, query, and write a [Little Big Brain](https://littlebigbrain.com) graph. Ships two ways: a hosted endpoint with OAuth sign-in, and a local stdio server.

## Hosted (OAuth) — recommended

The client opens WorkOS sign-in; your machine never stores a Little Big Brain key. Point it at your stack:

```json
{
  "mcpServers": {
    "lbb": {
      "url": "https://mcp.littlebigbrain.com/mcp/<stack-slug>"
    }
  }
}
```

Codex sends the URL as an OAuth `resource`, so use the origin plus a stack header instead:

```json
{
  "mcpServers": {
    "lbb": {
      "type": "http",
      "url": "https://mcp.littlebigbrain.com",
      "headers": { "X-LBB-Stack": "<stack-slug>" }
    }
  }
}
```

## Local (stdio)

Run against any data-plane endpoint with a stack API key:

```json
{
  "mcpServers": {
    "lbb": {
      "command": "npx",
      "args": ["-y", "@littlebigbrain/mcp"],
      "env": {
        "LBB_BASE_URL": "https://0abc1def--production.db.eu.littlebigbrain.com",
        "LBB_API_KEY": "lbb_sk_live_..."
      }
    }
  }
}
```

Set `LBB_GRAPH` or `LBB_BRANCH` to target a scope other than `main`.
`LBB_BASE_URL` has no hosted default: copy `endpoint_url` from the stack's
Connect page. The MCP process exits with a configuration error when it is
missing.

## Tools

| Tool | Use it for |
| --- | --- |
| `lbb_search` | hybrid retrieval, multi-query fusion, optional path following |
| `lbb_ask` | grounded answers with citations |
| `lbb_decode` | constrained relation decoding |
| `lbb_ground` | vocabulary completion and resolution |
| `lbb_inspect` | ontology, entity, state, history, provenance, traversal |
| `lbb_query` | SPARQL, structured analytics, SHACL, inference |
| `lbb_commit` | facts, properties, and embeddings |
| `lbb_observe` | conversation episodes plus reviewed extraction |
| `lbb_branch` | isolation branches and validated merge |
| `lbb_configure` | ontology, schema, and inference rules |
| `lbb_index` | BM25, vector, and adjacency refresh |

Read tools return compact structured envelopes by default — use `detail`, `row_limit`, and returned cursors to page without silently truncating. Write tools derive an idempotency key unless you provide one.

## Embed the server

For self-hosting behind your own auth, the package also serves the tools over HTTP:

```ts
import { createMcpHttpServer } from "@littlebigbrain/mcp";

createMcpHttpServer({
  baseUrl: "https://0abc1def--production.db.eu.littlebigbrain.com",
  mcpPath: "/mcp",
  allowedHosts: ["127.0.0.1", "localhost", "::1"],
}).listen(8080, "127.0.0.1");
```

The embedded server passes a key bearer to the data plane; the hosted endpoint's OAuth and ownership layer is served separately by the Little Big Brain API.

Full tool schemas and examples: [docs.littlebigbrain.com/sdks/mcp](https://docs.littlebigbrain.com/sdks/mcp/).
