# Changelog

All notable changes to the `@littlebigbrain/mcp` package are documented here.

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
