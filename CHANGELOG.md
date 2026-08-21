# Changelog

All notable changes to the `@littlebigbrain/mcp` package are documented here.

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
