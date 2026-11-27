import { LbbError, type LbbClient } from "@littlebigbrain/client";
import { lexicalRow, type Term } from "./query-tools.js";
import type { Detail } from "./tool-contracts.js";
import {
  ToolError,
  defaultRowLimit,
  normalizeDetail,
  toolResult,
} from "./tool-runtime.js";

// Reads across a catalog namespace: `POST /v1/query/namespace` through
// `client.sparqlNamespace`, and the catalog directory routes through
// `client.catalog`. Both are in `@littlebigbrain/client` 0.34.0 and later,
// which is the range this package requires.

/** The graph name the namespace route gives each selected source graph. */
export const GRAPH_URN_PREFIX = "urn:lbb:graph:";

const NAMESPACE_ID = /^(root|ns_[0-9a-f]{16,125})$/;
// The server resolves at most 15 segments of 1 to 64 lowercase characters.
const PATH = /^[a-z0-9_-]{1,64}(\/[a-z0-9_-]{1,64}){0,14}$/;
const PAGE_LIMIT = 100;

interface SparqlResults {
  head?: { vars?: string[] };
  boolean?: boolean;
  results?: { bindings?: Record<string, Term>[] };
}

export interface NamespaceQueryArgs {
  namespace?: string;
  include_descendants?: boolean;
  default_graph?: "union" | "empty";
  query?: string;
  row_limit?: number;
  cursor?: string;
  detail?: Detail;
}

export interface NamespacesArgs {
  namespace?: string;
  detail?: Detail;
}

interface NamespaceCursor {
  v: 1;
  mode: "namespace";
  namespace_id: string;
  include_descendants: boolean;
  default_graph: "union" | "empty";
  path?: string;
  query: string;
  row_limit: number;
  offset: number;
  selection_token: string;
}

/**
 * The namespace id for a path (`acme/projects`) or an id (`root`, `ns_…`).
 * A path resolves inside the connection's environment; an unknown path fails
 * with the route's own error.
 */
export async function resolveNamespace(
  client: LbbClient,
  namespace: string | undefined,
): Promise<{ id: string; path?: string }> {
  const value = (namespace ?? "root").trim().replace(/^\/+|\/+$/g, "");
  if (value === "" || value === "root") return { id: "root", path: "" };
  if (NAMESPACE_ID.test(value)) return { id: value };
  if (!PATH.test(value))
    throw new Error(
      "namespace must be a path of lowercase names joined by / (for example acme/projects), root, or an ns_ id",
    );
  try {
    const resolved = await client.catalog.resolve(value);
    return { id: resolved.identity.id, path: value };
  } catch (error) {
    // Without a graph selector the server can report a missing path as a
    // missing default graph; every 404 here means the path does not resolve.
    if (error instanceof LbbError && error.status === 404)
      throw new ToolError(
        "namespace_not_found",
        `no namespace at path ${value}; list namespaces with lbb_inspect action=namespaces`,
      );
    throw error;
  }
}

function encodeCursor(cursor: NamespaceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): NamespaceCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is not a namespace query cursor");
  }
  const cursor = value as Partial<NamespaceCursor>;
  if (
    cursor?.v !== 1 ||
    cursor.mode !== "namespace" ||
    typeof cursor.namespace_id !== "string" ||
    typeof cursor.query !== "string" ||
    typeof cursor.selection_token !== "string" ||
    !Number.isSafeInteger(cursor.offset) ||
    !Number.isSafeInteger(cursor.row_limit)
  )
    throw new Error("cursor is not a namespace query cursor");
  return cursor as NamespaceCursor;
}

/**
 * `lbb_query mode=namespace`: one SELECT or ASK across every ready graph of a
 * namespace. The server refuses the whole query when a source is missing or a
 * bound is reached, so every page here is from a complete selection. A
 * continuation runs the query again and fails if the selection changed.
 */
export async function namespaceQuery(
  client: LbbClient,
  args: NamespaceQueryArgs,
) {
  const cursor =
    args.cursor === undefined ? undefined : decodeCursor(args.cursor);
  if (cursor) {
    if (args.query !== undefined && args.query !== cursor.query)
      throw new Error(
        "cursor query does not match the supplied query argument",
      );
    if (args.row_limit !== undefined && args.row_limit !== cursor.row_limit)
      throw new Error(
        "cursor row_limit does not match the supplied row_limit argument",
      );
  }
  const query = cursor?.query ?? args.query;
  if (query === undefined || query.trim() === "")
    throw new Error("query is required unless cursor is supplied");
  const detail = normalizeDetail(args.detail);
  const rowLimit =
    cursor?.row_limit ?? args.row_limit ?? defaultRowLimit(detail);
  const scope = cursor
    ? { id: cursor.namespace_id, path: cursor.path }
    : await resolveNamespace(client, args.namespace);
  if (
    cursor &&
    args.namespace !== undefined &&
    (await resolveNamespace(client, args.namespace)).id !== cursor.namespace_id
  )
    throw new Error("cursor namespace does not match the supplied namespace");
  const includeDescendants =
    cursor?.include_descendants ?? args.include_descendants ?? true;
  const defaultGraph = cursor?.default_graph ?? args.default_graph ?? "union";
  const response = await client.sparqlNamespace({
    namespace_id: scope.id,
    include_descendants: includeDescendants,
    default_graph: defaultGraph,
    query,
  });
  if (cursor && response.selection_token !== cursor.selection_token)
    throw new Error(
      "the namespace selection changed since the first page (a graph was adopted, released or republished); run the query again without cursor",
    );
  const results = JSON.parse(response.results) as SparqlResults;
  const sources = response.sources.map((source) => ({
    graph: source.graph_id,
    graph_epoch: source.graph_epoch,
  }));
  const base = {
    mode: "namespace",
    namespace: { id: response.namespace.id, path: scope.path },
    include_descendants: includeDescendants,
    default_graph: defaultGraph,
    coverage: response.coverage,
    sources,
    charged_read_bytes: response.charged_read_bytes,
  };
  if (typeof results.boolean === "boolean")
    return toolResult({
      summary: `ASK over ${sources.length} graph(s): ${results.boolean}`,
      ...base,
      boolean: results.boolean,
    });
  const bindings = results.results?.bindings ?? [];
  const offset = cursor?.offset ?? 0;
  const rows = bindings
    .slice(offset, offset + rowLimit)
    .map((row) => lexicalRow(row));
  const end = offset + rows.length;
  const next =
    end < bindings.length
      ? {
          cursor: encodeCursor({
            v: 1,
            mode: "namespace",
            namespace_id: scope.id,
            include_descendants: includeDescendants,
            default_graph: defaultGraph,
            path: scope.path,
            query,
            row_limit: rowLimit,
            offset: end,
            selection_token: response.selection_token,
          }),
        }
      : undefined;
  return toolResult({
    summary: `${bindings.length} row(s) over ${sources.length} graph(s); rows ${offset + 1}-${end}`,
    ...base,
    columns: results.head?.vars ?? [],
    rows,
    row_page: {
      offset,
      returned: rows.length,
      total: bindings.length,
      has_more: next !== undefined,
    },
    ...(next ? { next } : {}),
    notes: [
      `GRAPH ?g binds each source as ${GRAPH_URN_PREFIX}<graph_id>; sources lists the graph ids and their pinned epochs.`,
      "The default graph is the RDF set union of the sources. Search, inference, FROM, SERVICE and updates are refused in this mode; use mode=sparql with graph=<graph_id> for one graph.",
    ],
  });
}

/**
 * `lbb_inspect action=namespaces`: one namespace, its child namespaces and the
 * graphs it owns directly. Walk the tree by calling it again with a child's
 * path. Each list is one page of at most 100; `more` says a list was cut.
 */
export async function inspectNamespaces(
  client: LbbClient,
  args: NamespacesArgs,
) {
  const scope = await resolveNamespace(client, args.namespace);
  const self =
    scope.id === "root" ? undefined : await client.catalog.namespace(scope.id);
  const children = await client.catalog.namespaces({
    parentId: scope.id,
    limit: PAGE_LIMIT,
  });
  const graphs = await client.catalog.graphs({
    ownerId: scope.id,
    limit: PAGE_LIMIT,
  });
  const prefix = scope.path
    ? `${scope.path}/`
    : scope.id === "root"
      ? ""
      : undefined;
  return toolResult({
    summary: `${children.items.length} child namespace(s), ${graphs.items.length} graph(s) owned directly`,
    namespace: {
      id: scope.id,
      path: scope.path,
      name: self?.name ?? (scope.id === "root" ? "" : undefined),
      external_key: self?.external_key ?? undefined,
    },
    children: children.items.map((child) => ({
      id: child.identity.id,
      name: child.name,
      path:
        prefix !== undefined && child.name
          ? `${prefix}${child.name}`
          : undefined,
    })),
    graphs: graphs.items.map((graph) => ({
      graph: graph.graph_id,
      state: graph.state,
      external_key: graph.external_key ?? undefined,
    })),
    more: {
      children: Boolean(children.next_cursor),
      graphs: Boolean(graphs.next_cursor),
    },
    notes: [
      "Query every graph under a namespace with lbb_query mode=namespace namespace=<path>. Query one graph with graph=<graph> on any other mode.",
    ],
  });
}
