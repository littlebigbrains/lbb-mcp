# @littlebigbrain/mcp

Eleven task-shaped MCP tools for searching, querying, and writing a little big
brain graph from Claude, Cursor, Codex, or another MCP client.

## Hosted OAuth

Use the hosted endpoint; the client opens WorkOS sign-in and your machine never
stores a little big brain stack key:

```json
{
  "mcpServers": {
    "lbb": {
      "url": "https://mcp.littlebigbrain.com/mcp/<stack-slug>"
    }
  }
}
```

Codex Desktop should use the origin plus a stack header:

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

## Local stdio

```json
{
  "mcpServers": {
    "lbb": {
      "command": "npx",
      "args": ["-y", "@littlebigbrain/mcp"],
      "env": {
        "LBB_BASE_URL": "https://db.eu.littlebigbrain.com",
        "LBB_API_KEY": "lbb_sk_live_..."
      }
    }
  }
}
```

Set `LBB_GRAPH` or `LBB_BRANCH` when the scope is not `main`.

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

Read tools return compact structured envelopes by default. Use `detail`,
`row_limit`, and returned cursors to page without silently truncating results.
Write tools derive idempotency keys unless you provide one.

## Embed the server

```ts
import { createMcpHttpServer } from "@littlebigbrain/mcp";

createMcpHttpServer({
  baseUrl: "https://db.eu.littlebigbrain.com",
  mcpPath: "/mcp",
  allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"],
}).listen(8080, "127.0.0.1");
```

The embedded HTTP server passes a key bearer to the database and is for
self-hosting behind your own auth. The hosted endpoint's OAuth/ownership layer
is served by the little big brain API.

Full tool schemas and examples: [MCP documentation](https://docs.littlebigbrain.com/sdks/mcp/).
