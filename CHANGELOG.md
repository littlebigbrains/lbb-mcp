# Changelog

All notable changes to the `@littlebigbrain/mcp` package are documented here.

## Unreleased

- Remove the `state`, `history`, `transitions`, and `why` actions from
  `lbb_inspect`. Their routes answered `429 ingest_busy` on every graph and
  are removed from the server. Read a node's past values with SPARQL and
  `as_of_commit_seq` through `lbb_query`.

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
