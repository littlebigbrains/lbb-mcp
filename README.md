# @littlebigbrain/mcp

Eight task-shaped [MCP](https://modelcontextprotocol.io) tools that let Claude, Cursor, Codex, or any MCP client search, query, and write a [Little Big Brain](https://littlebigbrain.com) graph. Ships two ways: a hosted endpoint with OAuth sign-in, and a local stdio server.

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
| `lbb_inspect` | graph discovery, complete paginated ontology/schema, publication status, entity, state, history, and provenance |
| `lbb_rdf` | import full RDF/OWL or add axioms using INSERT DATA |
| `lbb_query` | SPARQL text, structured SPARQL bodies, and canned analysis |
| `lbb_commit` | facts, properties, and embeddings |
| `lbb_observe` | conversation episodes plus reviewed extraction |
| `lbb_branch` | isolation branches and validated merge |
| `lbb_models` | shadow evaluation and training datasets |
| `lbb_configure` | native ontology definition/evolution and SHACL preview/publication |

Read tools return compact structured envelopes by default — use `detail`, `row_limit`, and returned cursors to page without silently truncating. Write tools derive an idempotency key unless you provide one.

Query pages preserve complete RDF values and may contain fewer than `row_limit`
rows to fit the 80 KB UTF-8 output budget. Follow the returned `next` arguments
until absent; the cursor advances by rows actually delivered. A single row that
exceeds the budget fails explicitly: project fewer fields or use the direct
SPARQL HTTP endpoint for that row.


Both `lbb_query` SPARQL modes (`sparql` and `structured`) support retained commit reads
through `as_of_commit_seq`. When omitted, the connector pins the current head
commit and reuses it for cursor pages. Valid-time `as_of` is unsupported and is
rejected before an API call, including when carried in an old cursor. Start a
new query without that selector or choose a retained commit sequence.

## Create and evolve an ontology through MCP

Start with `lbb_inspect action=guide`; `action=graphs` helps select an existing
scope, and a missing graph returns bootstrap guidance. Decide what questions
the graph must answer before choosing classes and relations. Distinguish
source-backed facts from hypotheses, and preserve evidence and dates.

Native metadata and stored RDF axioms are separate:

- `lbb_configure action=define_ontology` accepts a friendly `spec`, including
  class `super_types`. Unknown spec fields fail explicitly. `lbb_json` expects
  an internal serialized ontology, not a friendly spec. Raw OWL supplied to
  configure is reduced to native metadata; it is not stored as a full document.
- `lbb_rdf action=import` stores the complete Turtle, N-Triples, N-Quads, or TriG
  document as queryable graph facts, including RDF lists, annotations, and OWL
  axioms. Pass `source`; the published RDF tier supports only the default RDF
  graph. Dataset formats must contain only default-graph quads. The first RDF
  data write selects RDF-native storage, which refuses
  later property-graph commits; choose the write workflow before bootstrap.
- `lbb_configure action=evolve_ontology` supports explicit native changes,
  including `add_super_types`. `dry_run: true` previews define/evolve/publish;
  the same flag previews `lbb_commit mode=facts` without writing.
- `lbb_rdf action=update` submits SPARQL Update unchanged; currently only
  `INSERT DATA` is supported. DELETE, WHERE, and graph replacement are refused.
  Re-importing is
  additive and does not remove obsolete axioms. Content-based retry keys are
  automatic; use a new explicit key for an intentional repeat after other edits.

For example, add a superclass without a browser or RDF conversion:

```json
{
  "action": "update",
  "update": "INSERT DATA { <urn:Person> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:Contact> }"
}
```

Removing or replacing RDF axioms requires native bounded update support in the
engine. Until then, import a revised document into a new versioned LBB graph,
verify it, and explicitly switch consumers. Do not implicitly delete the original.

`publish_schema` activates SHACL shapes against unchanged native metadata.
Its preview checks parsing and compatibility without writing objects or
scheduling jobs; it does not audit the entire graph. Preview restrictive
native edits with evolve, resolve conflicts, then apply. For restrictive
SHACL, use warn → inspect conformance → repair → reject.

After applying, inspect `action=publication`, then verify both asserted axioms
and expected inferred answers. `lbb_query mode=sparql` accepts explicit
`entailment: "none" | "subclass" | "rdfs" | "owl"` (default `none`),
`consistency: "eventual" | "strong"`, and `min_indexed_seq`. Cursors retain
these controls. OWL is the server's supported inference profile, not arbitrary
OWL DL. An upload acknowledgement is not proof of successful reasoning.

To read asserted axioms in the default graph, query with `entailment: "none"`
and follow all returned row cursors:

```sparql
SELECT ?s ?p ?o WHERE {
  ?s ?p ?o
} ORDER BY ?s ?p ?o
```

`lbb_inspect action=ontology` and `action=schema` page complete native metadata
with `page_size` (default 50, maximum 500), optional `section`, and `cursor`.
Pass the returned `next` arguments until absent. These pages preserve nested
values even with `detail=compact`; they never replace the remainder with a
suggestion to repeat `detail=full`. If a single entry is too large, the result
contains `entry_fragment`: concatenate `serialized_json` by `char_offset`, then
JSON-parse the completed entry. Changed metadata invalidates the cursor rather
than mixing versions. Restart inspection after applying edits.

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

## Local end-to-end ontology check

From the repository root, build the server and SDKs, then opt into the isolated
real-server MCP test (it creates and removes its own temporary data root):

```sh
cargo build -p lbb-server
npm run build -w @littlebigbrain/client
LBB_TEST_SERVER_BIN="$PWD/target/debug/lbb-server" npm test -w @littlebigbrain/mcp
```

The test verifies native hierarchy evolution, preservation of RDF annotations,
subclass/inverse inference, additive edits, and refusal of unsupported deletion.
