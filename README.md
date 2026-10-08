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

An agent without a SPARQL query can pass the question in plain words:

```json
{
  "mode": "question",
  "graph": "quickstart",
  "question": "Which database does Auth Service write to?"
}
```

The server answers in plain words (`POST /v1/query/ask`). A router model picks
the kind of question. A reasoning model runs queries in a bounded loop, reads
their rows, and answers. The result holds `answer` (`text`, `citations`, the
IRIs the answer names, and `chart`, how to draw the rows, when the server
gave one), `steps`, the route, and the query and rows the answer stands on. `next` continues that query with `mode: "sparql"`. A
question takes about 8 s. Each question uses model tokens and counts toward a
daily limit of the stack, so the tool does not retry a failed call.

The server finds the names in the question in the graph and lists them in
`linked`. When the question is about records you already know, pass their
IRIs in `anchor` (at most 10): the queries use them directly. A question
about a date reads the last commit written by the end of that day; pass
`timeline` (`[{date, as_of_commit_seq, label?}]`) when the commits stand for
other dates. A question that asks what changed returns `history.added`,
`history.removed` and `history.changed`, with `history.totals`.

When the tool call carries a `_meta.progressToken`, the server sends a
progress notification for each step, for example `Route: lookup (router,
0.92)` or `Step 2, sparql SELECT ?db: 1 row`. The result is the same. Cancel
the call to stop the server's work.

To write the queries yourself, use `names`, `describe`, `commit_at` and
`compare`, then `mode: "sparql"`.

For your own data, start with `lbb_inspect` using `action: "guide"` or
`action: "ontology"`. Imported Resource Description Framework (RDF) data keeps
its original identifiers; inspect it with SPARQL when choosing query predicates.

## Tools

| Tool | Purpose |
| --- | --- |
| `lbb_inspect` | Read the schema, graph status, and entities. |
| `lbb_query` | Ask a question in plain words, run SPARQL queries, search by meaning (also inside a SPARQL query with `search:similarTo`), or request summary statistics. Four modes help an agent write its own queries: `names` (the IRIs of the names in a text), `describe` (the classes and properties a question needs, with how many instances hold each property and the values of small classes), `commit_at` (the commit of a date) and `compare` (one query at two points, the rows paired by entity). |
| `lbb_rdf` | Import RDF documents or add facts with SPARQL `INSERT DATA`. |
| `lbb_embeddings` | Inspect search setup and preview the text to embed. |
| `lbb_embeddings_manage` | Set up or refresh embeddings, or change the embedding model. |
| `lbb_embeddings_delete` | Delete an embedding and its stored vectors. |
| `lbb_fit_sources` | Inspect fit from text and preview the text the fit reads. |
| `lbb_fit_sources_manage` | Declare, dry-run or refresh a fit source. |
| `lbb_fit_sources_delete` | Delete a fit source; its suggestions stay. |
| `lbb_commit` | Write or retract JSON facts, or record search feedback. |
| `lbb_configure` | Define record types and relationships, list and apply ontology starters (CRM, documents, work), publish validation rules, or keep the graph's notes and worked examples for questions in plain words (`get_rewrite_profile`, `set_rewrite_profile`). |
| `lbb_evals` | Label query results and check whether later queries return the expected answers. Read the model checks of a graph, and agree with or correct a check that the user confirmed. |
| `lbb_model_choice` | Read which model each use runs (question answers, query routing, search rerank, ontology fit, eval labels), and the trials that test other models against the graph's ground truth. |
| `lbb_model_choice_manage` | Start or stop a trial, switch a use to a tested model that meets the bar, or revert to LBB's model. |
| `lbb_models` | Compare retrieval settings, read model training datasets, or read a month of managed-model activity. |

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
