# @littlebigbrain/mcp

An [MCP](https://modelcontextprotocol.io) server that gives an agent a small,
graph-aware tool belt over a [Little Big Brain](https://littlebigbrain.com) server. It wraps the
[`@littlebigbrain/client`](https://www.npmjs.com/package/@littlebigbrain/client) TypeScript SDK and ships two ways: a local
stdio shim (`npx @littlebigbrain/mcp`) and a hosted streamable-HTTP endpoint.

## Local (stdio) — Claude Code, Cursor, Codex

Add to your editor's MCP config (`.mcp.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "lbb": {
      "command": "npx",
      "args": ["-y", "@littlebigbrain/mcp"],
      "env": {
        "LBB_BASE_URL": "https://db.eu.littlebigbrain.com",
        "LBB_API_KEY": "lbb_sk_live_…"
      }
    }
  }
}
```

Set `LBB_GRAPH` / `LBB_BRANCH` to target a graph/branch other than `main`.
For a local server, point `LBB_BASE_URL` at `http://127.0.0.1:7400` and use the
single-mode token.

## Hosted (streamable-HTTP, WorkOS OAuth)

The hosted endpoint at `https://mcp.littlebigbrain.com` is served by Little Big
Brain's hosted SaaS API and authenticated with **native WorkOS MCP OAuth** — there is
no static bearer key. It is an OAuth 2.1 protected resource: WorkOS AuthKit is
the authorization server. Claude-style clients can use the per-stack URL:

```json
{
  "mcpServers": {
    "lbb": {
      "url": "https://mcp.littlebigbrain.com/mcp/<your-stack-slug>"
    }
  }
}
```

An MCP client that supports remote auth (Claude, Cursor, …) discovers the OAuth
flow automatically: the server answers an unauthenticated request with `401` and
a `WWW-Authenticate` challenge pointing at
`/.well-known/oauth-protected-resource/mcp/<slug>`, the client runs the AuthKit
sign-in (DCR/PKCE), and presents the resulting access token. The endpoint
validates the WorkOS JWT, confirms your account owns the stack, mints a
short-lived data-plane session, and runs the tools scoped to that stack — your
machine never holds a Little Big Brain key. Add `?graph=`/`?branch=` to the URL to target a
graph/branch other than `main`.

Codex Desktop currently sends the MCP server URL as an OAuth `resource`
parameter and also appends any configured `oauth_resource`, which produces a
duplicate `resource` query that AuthKit rejects. For Codex, use the MCP origin
as the URL and pass the stack in a header; do not set `oauth_resource`:

```json
{
  "mcpServers": {
    "lbb": {
      "type": "http",
      "url": "https://mcp.littlebigbrain.com",
      "headers": {
        "X-LBB-Stack": "<your-stack-slug>"
      }
    }
  }
}
```

For self-hosting (single-mode `lbb-server`), `npm run start:http` serves the
same tools over streamable-HTTP (default `127.0.0.1:8080/mcp`) with a simpler
**key** bearer passed straight through — use this only behind your own auth,
not as a multi-tenant public endpoint. It binds loopback by default and
rejects non-loopback `Host`/`Origin` headers (DNS-rebinding protection); set
`LBB_MCP_HOST` to bind another interface deliberately, and
`LBB_MCP_ALLOWED_HOSTS` / `LBB_MCP_ALLOWED_ORIGINS` (comma-separated) when it
sits behind a hostname you control.

## Embed in a Node process

The package entrypoint exposes a small, supported library API in addition to
the `lbb-mcp` executable:

- `createMcpHttpServer(options)` creates a Node `http.Server` with `/healthz`
  and a key-bearer streamable-HTTP MCP route.
- `buildLbbServer(client)` creates an MCP `McpServer` bound to an existing
  `LbbClient`.
- `registerLbbTools(server, client)` installs the eleven tools on an existing
  MCP server.

```ts
import {
  createMcpHttpServer,
  type McpHttpServerOptions,
} from "@littlebigbrain/mcp";

const options: McpHttpServerOptions = {
  baseUrl: "https://db.eu.littlebigbrain.com",
  mcpPath: "/mcp",
  maxBodyBytes: 1_048_576,
  requestTimeoutMs: 30_000,
  // DNS-rebinding protection: reject other Host/Origin headers on the MCP
  // route. Omit only when an edge you control already pins Host.
  allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"],
  onError: () => console.error("MCP request failed"),
};

createMcpHttpServer(options).listen(8080, "127.0.0.1");
```

Clients call `POST /mcp` with `Content-Type: application/json` and
`Authorization: Bearer <LBB_API_KEY>`; add `?graph=` / `?branch=` to override
the default scope. `clientFactory` is also available in
`McpHttpServerOptions` for dependency injection. The hosted multi-tenant OAuth
edge is intentionally not part of this library API.

### Create an ontology (so agents can use a typed graph)

`lbb_configure` with `action: "define_ontology"` creates a **new** graph with a custom ontology, since the
ontology is fixed at graph creation. Give it entity-type and relation names (the
agent-friendly "spec" shape) and Little Big Brain fills in ids and sensible defaults:

```jsonc
// lbb_configure
{
  "action": "define_ontology",
  "graph": "support",
  "entity_types": [{ "name": "Customer" }, { "name": "Ticket" }],
  "relations": [
    { "name": "OPENED", "source": ["Customer"], "target": ["Ticket"], "reducer": "append_only" }
  ]
}
```

Then `lbb_commit` typed facts against the new graph and `lbb_inspect`
with `action: "ontology"` to confirm the vocabulary. For an existing standard ontology, pass a raw
`source` document with `format` (`turtle`, `json_ld`, `rdf_xml`, `csv`, `tsv`,
or `lbb_json`; omit or `auto` to auto-detect) instead of the structured
fields.

## Tools

Agent-shaped task tools, not one tool per route. The previous route-shaped
surface is replaced by these eleven task tools, with no legacy aliases.

| Tool | Purpose |
| --- | --- |
| `lbb_search` | natural-language retrieval, multi-query fusion, and optional text-seeded path following |
| `lbb_ask` | grounded natural-language answers with citations |
| `lbb_decode` | name a relation from the graph's admissible vocabulary |
| `lbb_ground` | complete, resolve, or audit terms against real graph vocabulary |
| `lbb_inspect` | graph context and exact reads: guide, ontology, RDF/SHACL schema, stored rules, metadata, entity, state, history, why, traverse |
| `lbb_query` | analytical/expert reads: structured query, SPARQL text, SHACL, inference, retrieval premises, canned analysis |
| `lbb_commit` | write triplets, embeddings, or entity properties; omitted idempotency keys are content-derived for agent retries |
| `lbb_observe` | store a conversation episode and gate extracted facts on an isolation branch |
| `lbb_branch` | create and validate-then-merge graph branches |
| `lbb_configure` | define a new graph ontology, publish a previewed RDF/SHACL schema, or replace stored inference rules |
| `lbb_index` | refresh persisted BM25, vector, and adjacency indexes |

Read tools accept `detail: "compact" | "standard" | "full"` and default to
compact structured envelopes: `{summary, data, counts?, truncated?, rows_shown?, next?}`.
`detail` controls verbosity only. Query row volume is controlled by
`row_limit` plus cursor paging: tabular `lbb_query` responses include
`row_page: {returned, total, offset, limit, has_more, next_offset?}`. Whenever a
query page is partial, `summary` says `returned X of Y rows` and `next` contains
`{mode, cursor, row_limit, detail}`; pass that cursor back to continue without
hand-writing `LIMIT/OFFSET`. Cursor continuation reuses the original query/body
and pins every page to the head commit observed on page 1, so live writes between
pages cannot shift offset slicing. When the server returns a *complete* page
(`has_more: false`) whose rows are nonetheless too large to fit one MCP tool
result, the envelope caps the displayed rows and reports `rows_shown` (fewer than
`row_page.returned`) so the cap is never silent; `summary` reads
`MCP showed N of M rows` and `next` still carries a cursor that re-pages the same
result set at a smaller `row_limit`. A large result that *does* fit carries no
hard-cap warning and no `rows_shown`.
`lbb_inspect action=entity` samples its `incoming`/`outgoing`/`history` arrays to
the detail cap while `counts` holds the true totals; on a high-degree node the
response carries an `edge_sample` block (`{note, capped_totals, full_reads}`) with
runnable paged `edges`/`history` reads, so reading every edge of a supernode is
discoverable in-band rather than a workaround you have to already know.
Mode/action tools use discriminated schemas, so each selected mode or action
only accepts the fields that apply to that branch.
All server `LbbError` fields survive the MCP boundary in
`structuredContent.error` so agents can self-correct. A graph-scope 404 (the
raw `not found: tenants/…/graphs/<g>/branches/<b>/heads/current.json` object
key) is rewritten into an actionable message that lists the tenant's real
graphs — or, when the graph exists but the branch does not, its real branches —
and tells you which `graph=`/`branch=` to pass. The connection targets a default
graph/branch (often `main`) when you omit them.
When `lbb_commit` omits `idempotency_key`, MCP derives one from the graph,
branch, and payload; intentionally repeating an identical commit within the
server retention window requires an explicit different `idempotency_key`.
MCP defaults `edge_idempotency` to `append`, so new evidence on an existing edge
is recorded. Pass `edge_idempotency: "skip_unchanged"` for re-runnable
backfills; exact duplicate current edges are skipped server-side, including
evidence-only repeats.

### Migration table

| Old tool | New tool/action or mode |
| --- | --- |
| `lbb_multi_search` | `lbb_search` with `queries` |
| `lbb_semantic_traverse` | `lbb_search` with `follow_paths: true` |
| `lbb_traverse` | `lbb_inspect` with `action: "traverse"` |
| `lbb_current_state` | `lbb_inspect` with `action: "state"` |
| `lbb_history` | `lbb_inspect` with `action: "history"` |
| `lbb_why` | `lbb_inspect` with `action: "why"` |
| `lbb_ontology_search` | `lbb_inspect` with `action: "ontology_search"` |
| `lbb_ontology_view` | `lbb_inspect` with `action: "ontology"` |
| `lbb_graph_metadata` | `lbb_inspect` with `action: "metadata"` |
| entity detail | `lbb_inspect` with `action: "entity"` |
| `lbb_query_guide` | `lbb_inspect` with `action: "guide"` |
| schema view / audit / preview | `lbb_inspect` with `action: "schema"`, `"schema_audit"`, or `"schema_preview"` |
| stored rules view | `lbb_inspect` with `action: "rules"` |
| `lbb_sparql` | `lbb_query` with `mode: "sparql"` |
| `lbb_shacl` | `lbb_query` with `mode: "shacl"` |
| `lbb_infer` | `lbb_query` with `mode: "infer"` |
| `lbb_retrieval_premises` | `lbb_query` with `mode: "retrieval_premises"` |
| `lbb_analyze` | `lbb_query` with `mode: "analyze"` |
| `lbb_define_rules` | `lbb_configure` with `action: "define_rules"` |
| `lbb_ontology_define` | `lbb_configure` with `action: "define_ontology"` |
| schema publish | `lbb_configure` with `action: "publish_schema"` |
| `lbb_index_build` | `lbb_index` |
| `lbb_json` | no MCP replacement; use `@littlebigbrain/client` or direct HTTP for raw/operator endpoints intentionally outside the agent tool belt |

### Querying: SPARQL-subset, SHACL, inference

Three complementary surfaces sit over the object-storage permutation view:

- **`lbb_query` mode `structured`** is a SPARQL-subset SELECT/ASK over a conjunctive basic graph
  pattern (`patterns`) with `filters` (typed-literal FILTER), `group_by` +
  `aggregates` (COUNT/SUM/AVG/MIN/MAX), `having`, `order_by`,
  and `as_of_valid_time`. A `filters`/`having` entry has the exact shape
  `{ compare: { op: eq|ne|lt|le|gt|ge, left, right } }` (or `and`/`or`/`not`),
  where each operand is `{ var }`, `{ property: { var, field } }`, or a typed
  `{ value: { str | i64 | f64 | bool | date_time | entity } }` — e.g.
  `filters: [{ compare: { op: "ge", left: { property: { var: "d", field: "amount" } }, right: { value: { f64: 1000000 } } } }]`.
  A pattern `predicate` is a relation name and is case-insensitive here. GROUP BY
  is not limited to entity identity — `group_keys` can key on a typed scalar
  attribute (`{ property: { var, field, as } }`) or a calendar bucket of a
  datetime attribute (`{ date_bucket: { var, field, granularity, as } }`), and
  those same attribute fields work in `filters` and as SUM/AVG/MIN/MAX operands.
  So "commits per area per month" is one server-side query, not N entity fetches
  bucketed by hand:

  ```json
  {
    "patterns": [{ "subject": { "var": "c" }, "predicate": "committed_to", "object": { "var": "repo" } }],
    "group_keys": [
      { "date_bucket": { "var": "c", "field": "committed_at", "granularity": "month", "as": "m" } },
      { "property": { "var": "c", "field": "area", "as": "area" } }
    ],
    "aggregates": [{ "func": "count", "as": "n" }],
    "order_by": [{ "var": "m" }]
  }
  ```

  `area`/`committed_at` are typed entity attributes (set via `entity_properties`,
  read back flat under `attributes` — there is no nested `metadata.attributes`
  blob); discover the queryable field names with `lbb_inspect action=ontology`
  (`property_defs`) or `action=schema`. Pass `combinators` (`union`/`optional`/`minus`/
  `exists`/`not_exists`) for group-graph-pattern legs — those return `solutions`
  and are a separate request shape from aggregation. In MCP, use `row_limit` and
  the returned `next.cursor` for row pages; the tool applies request-level
  `limit`/`offset` for you and a cursor continuation reuses the original body.
  Cheap aggregate count: pair an equality `having` (`{ compare: { op: "eq",
  left: { var: "n" }, right: { value: { i64: 4 } } } }`) with `row_limit: 1` and
  read the number of matching groups off `row_page.total` — no need to page every
  matching row.
- **`lbb_query` mode `shacl`** evaluates node shapes: `shacl_mode: select` returns focus nodes
  that match, `shacl_mode: validate` returns a conformance `report`. It is the home of
  **property paths** (`path_expr`: `inverse`, `sequence`, `alternative`,
  `one_or_more`/`zero_or_more`/`zero_or_one`), literal constraints (`datatype`,
  `minInclusive`…, `pattern`, length), `unique` cross-node keys, `closed`
  nodes, and logical `and`/`or`/`not`/`xone`.
- **`lbb_query` mode `infer`** runs SHACL-AF inference rules to a bounded fixpoint and
  previews the derived edges (never written). **`lbb_configure` action
  `define_rules`** stores a rule set so SHACL `include_derived` can
  validate/select over inferred facts.

SPARQL text (`mode: "sparql"`) addresses relations/types/properties as
`<https://littlebigbrain.com/{r,class,p}/name>`, and the local name is **always
lowercase** — an uppercase one (e.g. `<…/r/FOR_CLIENT>`) is a different,
non-existent IRI that silently matches nothing. The tool auto-lowercases those
Little Big Brain IRI local names for you (percent-escapes preserved; foreign IRIs and string
literals untouched) and reports each rewrite under `notes`, so a stray uppercase
resolves instead of returning an empty result with no error.

### RDF schema and stored rules workflow

Agents should treat RDF/SHACL schema changes as preview-then-publish:

1. Read current state with `lbb_inspect` `action: "schema"` and stored rules with
   `action: "rules"`.
2. Preview proposed SHACL/RDF shapes with `lbb_inspect`
   `action: "schema_preview"`. Shape sources accept `auto`, `turtle`,
   `n_triples`, `n_quads`, or `trig`. Ontology sources accept `auto`, `spec`,
   `lbb_json`, `json_ld`, `rdf_xml`, `csv`, `tsv`, or `turtle`.

```jsonc
// lbb_inspect
{
  "action": "schema_preview",
  "desired_mode": "reject",
  "shapes": {
    "format": "turtle",
    "source": "@prefix sh: <http://www.w3.org/ns/shacl#> .\n..."
  }
}
```

The preview result includes the `preview_digest`, compatibility verdict, allowed
publish modes, audit summary, messages, and a `suggested_publish_schema` tool
call when the bundle can be activated in some mode. Publish only with the exact
source used for preview:

```jsonc
// lbb_configure
{
  "action": "publish_schema",
  "preview_digest": "sha256:...",
  "desired_mode": "warn",
  "confirm_restrictive": true,
  "shapes": {
    "format": "turtle",
    "source": "@prefix sh: <http://www.w3.org/ns/shacl#> .\n..."
  }
}
```

After publishing, run `lbb_inspect` `action: "schema_audit"` and read back
`action: "schema"`. For stored inference rules, preview behavior with
`lbb_query` `mode: "infer"` first, then replace the branch rule set with
`lbb_configure` `action: "define_rules"`. `define_rules` requires a `rules`
array; replacing the stored set with an empty array requires
`confirm_empty: true`.

SPARQL text `SELECT`/`ASK` is exposed through `lbb_query` `mode: "sparql"` and
returns SPARQL Results JSON inside the MCP row-page envelope. SPARQL Update,
SPARQL Protocol details, and SHACL-SPARQL/AF conformance remain a separate
compliance track; the structured SHACL/inference tools above are the
object-storage-native shape/inference surface.

Operator-only actions (index GC, compaction, storage inspection) are
intentionally left to the [`lbb` CLI](https://docs.littlebigbrain.com/sdks/cli/), not the agent
tool belt.

## Develop

```sh
npm install
npm run build
npm test                 # in-memory MCP + bounded localhost HTTP tests
npm run test:coverage
npm run pack:check        # exact tarball: publint + ATTW
npm start                # stdio server from the environment
```

The self-hosted HTTP edge defaults to a 1 MiB request-body cap and 30-second
request timeout, requires JSON plus a bearer token, and redacts unexpected
internal errors. Override its path with `LBB_MCP_PATH`; the hosted multi-tenant
endpoint remains the WorkOS OAuth service described above.
