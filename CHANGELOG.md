# Changelog

All notable changes to the `@littlebigbrain/mcp` package are documented here.

## 0.9.0 (2026-10-04)

- Require `@littlebigbrain/client` ^0.19.0.
- `lbb_query` with `mode: "sparql"` returns the `search` report of a query
  that searches by meaning with a `search:similarTo` pattern: the plan, the
  hits asked for and bound, and `complete`. When `complete` is false, `notes`
  says so. The `query` argument describes the pattern with an example.
- Add `activity` to `lbb_models`. It reads one month of the stack's
  managed-model use (`month`, `yyyy-mm`; the current month by default): calls,
  items, estimated tokens and cost per feature and model, by day and by
  graph, and the model each feature uses now.
- `lbb_inspect` with `action: "entity"` refuses a valid-time `as_of` before
  any request and names `as_of_commit_seq`. It sent `as_of` to the server,
  which answers it with 400.
- `lbb_query mode=search` takes `rerank`: `true` orders the best hits by the
  managed rerank model (Jev), each hit with its `relevance`; `false` keeps
  the similarity order. Without it the graph's search setting decides.
- Add `mode: "question"` to `lbb_query`, for an app or agent that has a
  question in plain words and no SPARQL query. It takes `question` and
  optional `context`, `route`, `limit` and `run` (default `true`), and calls
  `POST /v1/query/rewrite`. The result holds the route (`kind`, `confidence`,
  `by`), the rationale, the SPARQL query and its entailment, the rows, the
  `error` and the eval `trace_id`. The rows are bounded as in `mode: "sparql"`,
  and `next` continues the same query with `mode: "sparql"` at the commit the
  run read. A failed call is not retried, because each call uses model tokens.
- Add the model checks to `lbb_evals`. `checks_summary` reads a month of the
  graph's checks per job and model, and the judge's agreement with people
  (`month`, `yyyy-mm`; the current month by default). `checks` lists the
  month's checks, newest first, with the judge's verdict, score and reason
  and the ground truth; `job`, `verdict` and `reviewed` filter, and `after`
  pages. `review_check` records a person's review of one check (`call_id`):
  `agree: true` keeps the judge's verdict, and `agree: false` with `verdict`
  and an optional `score`, `reference` and `note` corrects it. The review
  becomes the call's ground truth, so the tool tells the agent to review only
  what the user confirmed. An incomplete review sends no request.

## 0.8.1 (2026-10-03)

- `suggest_ontology_change` takes up to 128 operations in `change`, the same
  limit as the server. It refused more than 64.

## 0.8.0 (2026-10-02)

- Add `list_starters` and `apply_starter` to `lbb_configure`. `list_starters`
  lists the base ontologies (`crm`, `documents`, `work`) with each one's
  status on the graph: `absent`, `partial` or `applied`, what applying would
  add, and the terms the graph holds differently. `apply_starter` adds what
  the graph lacks of one in one ontology version; `dry_run: true` answers the
  operations without writing.
- Add `suggest_ontology_change` to `lbb_configure`. An agent files an
  ontology change for a person to review instead of applying it. The change
  uses the same operations as `evolve_ontology`.
- Add `ontology_suggestions` to `lbb_inspect`. It lists the suggestions and
  their state. Agents cannot accept suggestions.
- Require `@littlebigbrain/client` ^0.17.0.

## 0.7.1 (2026-09-26)

- `lbb_query` with `mode: "search"` honours `detail`. Every search used the
  compact limits (5 hits, text cut at 300 characters) whatever the caller
  asked for. `compact` stays the default.

## 0.7.0 (2026-09-26)

- Remove the `state`, `history`, `transitions`, and `why` actions from
  `lbb_inspect`. Their routes answered `429 ingest_busy` on every graph and
  are removed from the server. Read a node's past values with SPARQL and
  `as_of_commit_seq` through `lbb_query`.
- Require `@littlebigbrain/client` ^0.15.0.

## 0.6.0 (2026-09-25)

Breaking removal of branches, observe, and planner training. Every graph has
one line of history.

- Remove the `branch` argument from every tool, `LBB_BRANCH` from the stdio
  server, and `?branch=` from the HTTP server. Tools are scoped by graph only.
- Remove the `lbb_branch` and `lbb_observe` tools.
- Remove the `planner_dataset` and `planner_preference_dataset` actions from
  `lbb_models`. The server no longer trains the planner.
- Require `@littlebigbrain/client` ^0.14.0.

## 0.5.2 (2026-09-24)

- Require `@littlebigbrain/client` 0.13.2 or later in the 0.13 series, which
  provides the search and evaluation methods used by the MCP tools.
- Add tools to inspect, configure, and delete embeddings, plus search by
  meaning through `lbb_query` with class and relationship filters.
- Add `lbb_evals` for query traces, result labels, and repeatable checks against
  saved queries.
- Keep SPARQL pages on the same commit and return complete values within each
  page's size limit.
- Rewrite the README with connection instructions, a complete RDF import and
  query example, expected output, and links to the current guides.

## 0.5.1 (2026-09-18)

- Bound query pages by UTF-8 bytes while preserving complete RDF values.
- Advance continuation cursors by the number of rows actually delivered, so
  large pages cannot skip rows when they reach the output budget.
- Return an actionable error when a single complete row exceeds that budget.

## 0.5.0 (2026-09-18)

- Return complete ontology and schema definitions with bounded, version-bound
  pagination; add graph discovery and publication-readiness inspection.
- Preview configuration and fact writes with `dry_run`, and expose superclass
  changes through ontology evolution.
- Add `lbb_rdf` for RDF document import and additive `INSERT DATA` updates.
  RDF deletion/replacement and named graphs remain unsupported by the engine.
- Expose query entailment, consistency, and minimum published sequence options,
  preserving them across pagination.
- Require `@littlebigbrain/client` 0.13.1 or newer in the 0.13.x line.
- Report the installed package version in the MCP initialization handshake.

## 0.4.3 (2026-08-31)

- Publish against the `@littlebigbrain/client` 0.13.x line, which adds the
  observed-schema summary and publication-status client methods. MCP's tool
  surface is unchanged.

## 0.4.2 (2026-08-24)

- Publish against the maintained `@littlebigbrain/client` 0.12.x line. MCP's
  schema publication and conformance tools are unchanged; request-time SHACL
  models and `/v1/query/shacl` were never part of its supported tool surface.

## 0.4.1 (2026-08-22)

- Publish against the maintained `@littlebigbrain/client` 0.11.x line so new
  MCP installations receive the publication-readiness fixes. The previously
  published 0.4.0 manifest still referenced the older 0.10.x client line.

## 0.4.0 (2026-08-21)

Breaking removal of every non-SPARQL query surface. SPARQL is the only query
surface, so the retrieval tools that fronted the removed routes are gone.

- Remove the `lbb_search` tool (hybrid search and multi-query fusion).
- Remove the `lbb_ground` tool (vocabulary completion, term resolution, and the
  groundability audit).
- Remove the `lbb_decode` tool (constrained relation decoding).
- `lbb_query` mode=structured now runs only on the structured SPARQL route. A
  body carrying `combinators` (UNION/OPTIONAL/MINUS/EXISTS) is rejected with a
  message pointing at mode=sparql, because the analytics route was removed.
- `lbb_query` mode=analyze drops the `facets` metric, which read the removed
  semantic graph search route. `entity_types`, `relations`, `overview`, and
  `sparql` are unchanged.
- `lbb_inspect`, `lbb_models`, `lbb_commit` (including mode=search_feedback),
  `lbb_configure`, `lbb_branch`, and `lbb_observe` are unchanged.
- Requires `@littlebigbrain/client` 0.11.x, the release with the same query-surface removal.


## 0.3.0 (2026-08-21)

Breaking removal of the standalone graph-traversal surface.

- Remove the `follow_paths` tool and graph-inspection traversal actions.
- Use SPARQL 1.1 property paths through the query tools for exact multi-hop
  graph queries; semantic search retains bounded graph-path evidence.
- Require `@littlebigbrain/client` 0.10.x, the release that carries the same
  traversal-surface removal and the RDF import `build` option.

## 0.2.7

- Require `@littlebigbrain/client` 0.9.x so MCP installations use the public
  durable-import-capable client contract.
- Repair the standalone package lockfile so clean installs resolve the declared
  client dependency.
