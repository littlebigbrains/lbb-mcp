# @littlebigbrain/mcp

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for
[little big brain](https://littlebigbrain.com), a search platform for AI
applications such as chatbots, search tools, and agents.

Connect an MCP client to search your data, follow relationships, and read the
facts behind an answer. The tools also let you load data and define validation
rules.

[Documentation](https://docs.littlebigbrain.com/sdks/mcp/) ·
[Quickstart](https://docs.littlebigbrain.com/start/quickstart/) ·
[Issues](https://github.com/littlebigbrains/lbb-mcp/issues)

## Connect

Create a stack in the [console](https://cloud.littlebigbrain.com), then choose a
hosted connection or a local process.

### Hosted connection

For clients that support remote MCP with OAuth, use this URL and sign in with
your little big brain account. Replace `<stack-slug>` with your stack's slug:

```text
https://mcp.littlebigbrain.com/mcp/<stack-slug>
```

For clients that use an `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "lbb": {
      "url": "https://mcp.littlebigbrain.com/mcp/<stack-slug>"
    }
  }
}
```

This connection uses account sign-in and does not require a stack API key.
The [connection guide](https://docs.littlebigbrain.com/sdks/mcp/#hosted-streamable-http-oauth)
includes client-specific setup, including the origin URL and `X-LBB-Stack` header
for Codex.

### Local process

Requires Node.js 18+. Copy the complete endpoint and a stack API key from
**Connect** in the console, then add them to your client's MCP configuration:

```json
{
  "mcpServers": {
    "lbb": {
      "command": "npx",
      "args": ["-y", "@littlebigbrain/mcp"],
      "env": {
        "LBB_BASE_URL": "https://<your-complete-stack-host>",
        "LBB_API_KEY": "<your-stack-api-key>"
      }
    }
  }
}
```

The client starts the server and communicates through standard input and output
(stdio). Keep the key in your local configuration. Set `LBB_GRAPH` to change
the default graph from `main`.

## Run a first query

This example stores three facts in a graph named `quickstart`: a service writes
to a database, and each has a label. The graph is created on its first write.

Ask your client to call `lbb_rdf` with these arguments:

```json
{
  "action": "import",
  "graph": "quickstart",
  "format": "ntriples",
  "source": "<https://example.org/auth-service> <https://example.org/writesTo> <https://example.org/user-db> .\n<https://example.org/auth-service> <http://www.w3.org/2000/01/rdf-schema#label> \"Auth Service\" .\n<https://example.org/user-db> <http://www.w3.org/2000/01/rdf-schema#label> \"User Database\" .",
  "idempotency_key": "mcp-quickstart-v1"
}
```

Now ask **which database does Auth Service write to?** The `lbb_query` call is:

```json
{
  "mode": "sparql",
  "graph": "quickstart",
  "consistency": "strong",
  "query": "SELECT ?database WHERE { <https://example.org/auth-service> <https://example.org/writesTo> ?db . ?db <http://www.w3.org/2000/01/rdf-schema#label> ?database } ORDER BY ?database LIMIT 10"
}
```

The result contains one row on a fresh graph:

| database |
| --- |
| User Database |

The query follows a stored relationship to its database label. Strong consistency
lets it read the import without waiting for a background index job.

For your own data, start with `lbb_inspect` using `action: "guide"` or
`action: "ontology"`. Imported Resource Description Framework (RDF) data keeps
its original identifiers; inspect it with SPARQL when choosing query predicates.

## Tools

| Tool | Purpose |
| --- | --- |
| `lbb_inspect` | Read the schema, graph status, and entities. |
| `lbb_query` | Run SPARQL queries, search by meaning, or request summary statistics. |
| `lbb_rdf` | Import RDF documents or add facts with SPARQL `INSERT DATA`. |
| `lbb_embeddings` | Inspect search setup and preview the text to embed. |
| `lbb_embeddings_manage` | Set up or refresh embeddings, or change the embedding model. |
| `lbb_embeddings_delete` | Delete an embedding and its stored vectors. |
| `lbb_commit` | Write or retract JSON facts, or record search feedback. |
| `lbb_configure` | Define record types and relationships, or publish validation rules. |
| `lbb_evals` | Label query results and check whether later queries return the expected answers. |
| `lbb_models` | Compare retrieval settings and read model training datasets. |

See [search by meaning](https://docs.littlebigbrain.com/guides/search-by-meaning/)
for embedding setup. To define constraints with the Shapes Constraint Language
(SHACL), see [query and validation](https://docs.littlebigbrain.com/guides/sparql-and-shacl/).

RDF imports and JSON facts use different write workflows. A graph first written
through `lbb_rdf` does not accept JSON fact writes through `lbb_commit`. Choose
the workflow when creating the graph. RDF updates
support additive `INSERT DATA`;
see the [RDF guide](https://docs.littlebigbrain.com/guides/load-rdf/) for format and
update limits.

## Pages and saved queries

When a result includes `next`, pass those arguments to the same tool to read the
next page. Continue until `next` is absent. `row_limit` sets a maximum; large
values can make a page shorter.

SPARQL queries keep the same commit across pages. Save the query and its returned
commit sequence to check an answer later, then use `as_of_commit_seq` to select
that version. See [history and replay](https://docs.littlebigbrain.com/guides/time-travel-audit/)
for retention and evidence handling.

## Embed the server

To serve the tools from your own Node.js process:

```ts
import { createMcpHttpServer } from "@littlebigbrain/mcp";

createMcpHttpServer({
  baseUrl: process.env.LBB_BASE_URL!,
  mcpPath: "/mcp",
  allowedHosts: ["127.0.0.1", "localhost", "::1"],
}).listen(8080, "127.0.0.1");
```

Clients connect to `http://127.0.0.1:8080/mcp` and send a stack API key in
`Authorization: Bearer <key>`. See the
[Node.js integration guide](https://docs.littlebigbrain.com/sdks/mcp/#embed-in-a-node-process)
for HTTP options and integration with an existing MCP server.

## Development

From a clone of this repository:

```sh
npm ci
npm run build
npm run typecheck
npm test
```

## License

[Apache-2.0](LICENSE).
