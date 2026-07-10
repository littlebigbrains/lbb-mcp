import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { LbbClient, LbbError } from "@littlebigbrain/client";
import {
  DEFAULT_DETAIL,
  HARD_OUTPUT_CHARS,
  MAX_QUERY_ROW_LIMIT,
  type ChartPoint,
  type Detail,
  type GraphMetadataResponse,
  type NamedCount,
  type QueryCursor,
  type RowPage,
} from "./tool-contracts.js";

export const scoped = (
  client: LbbClient,
  graph?: string,
  branch?: string,
): LbbClient =>
  graph !== undefined || branch !== undefined
    ? client.withScope({ graph, branch })
    : client;

export function normalizeDetail(detail?: string): Detail {
  return detail === "standard" || detail === "full" ? detail : DEFAULT_DETAIL;
}

export function defaultRowLimit(detail: Detail): number {
  switch (detail) {
    case "full":
      return 1_000;
    case "standard":
      return 100;
    default:
      return 20;
  }
}

export function effectiveRowLimit(detail: Detail, requested?: number): number {
  return Math.min(requested ?? defaultRowLimit(detail), MAX_QUERY_ROW_LIMIT);
}

export function encodeQueryCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(stable(cursor))).toString("base64url");
}

export function decodeQueryCursor(cursor?: string): QueryCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as QueryCursor;
    if (
      decoded.v !== 1 ||
      (decoded.mode !== "sparql" && decoded.mode !== "structured")
    ) {
      throw new Error("unsupported cursor");
    }
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0)
      throw new Error("invalid cursor offset");
    decoded.row_limit = effectiveRowLimit(decoded.detail, decoded.row_limit);
    return decoded;
  } catch (error) {
    throw new Error(
      `invalid lbb_query cursor: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function assertCursorScope(
  args: { graph?: string; branch?: string },
  cursor?: QueryCursor,
): void {
  if (!cursor) return;
  if (args.graph !== undefined && args.graph !== cursor.graph) {
    throw new Error("cursor graph does not match the supplied graph argument");
  }
  if (args.branch !== undefined && args.branch !== cursor.branch) {
    throw new Error(
      "cursor branch does not match the supplied branch argument",
    );
  }
}

export function rowPageFrom(value: unknown): RowPage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rowPage = (value as { row_page?: unknown }).row_page;
  if (!rowPage || typeof rowPage !== "object") return undefined;
  const page = rowPage as Partial<RowPage>;
  if (
    typeof page.returned !== "number" ||
    typeof page.total !== "number" ||
    typeof page.offset !== "number" ||
    typeof page.limit !== "number" ||
    typeof page.has_more !== "boolean"
  ) {
    return undefined;
  }
  return {
    returned: page.returned,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    has_more: page.has_more,
    next_offset:
      typeof page.next_offset === "number" ? page.next_offset : undefined,
  };
}

export function serverTruncationFlags(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const flags = [
    ["truncated", "solution cap"],
    ["truncated_by_read_budget", "read budget"],
  ] as const;
  return flags.flatMap(([key, label]) =>
    (value as Record<string, unknown>)[key] === true ? [label] : [],
  );
}

export function headCommitSeqFromMetadata(
  metadata: GraphMetadataResponse,
): number {
  const commitSeq = metadata.snapshot?.commit_seq;
  if (
    typeof commitSeq !== "number" ||
    !Number.isInteger(commitSeq) ||
    commitSeq < 0
  ) {
    throw new Error(
      "graph metadata did not include a valid snapshot.commit_seq",
    );
  }
  return commitSeq;
}

export async function queryCommitPin(
  target: LbbClient,
  requested?: number,
  cursor?: QueryCursor,
): Promise<number | undefined> {
  if (cursor) return cursor.as_of_commit_seq;
  if (requested !== undefined) return requested;
  return headCommitSeqFromMetadata(await target.metadata());
}

export function continuationNext(
  cursor: Omit<QueryCursor, "offset">,
  offset: number,
  rowLimit: number,
): Record<string, unknown> {
  return {
    mode: cursor.mode,
    cursor: encodeQueryCursor({ ...cursor, row_limit: rowLimit, offset }),
    row_limit: rowLimit,
    detail: cursor.detail,
  };
}

export function rowPageNext(
  cursor: Omit<QueryCursor, "offset">,
  page?: RowPage,
): Record<string, unknown> | undefined {
  if (!page?.has_more) return undefined;
  return continuationNext(
    cursor,
    page.next_offset ?? page.offset + page.returned,
    cursor.row_limit,
  );
}

export function nextDetail(detail: Detail): Detail | undefined {
  if (detail === "compact") return "standard";
  if (detail === "standard") return "full";
  return undefined;
}

export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

// Little Big Brain's RDF projection mints relation/class/property predicate IRIs from the
// *normalized* (lowercased) name, so the canonical local part is always
// lowercase. A SPARQL term like <https://littlebigbrain.com/r/FOR_CLIENT> is therefore a
// different — and non-existent — IRI than the real <…/r/for_client>, and it
// matches nothing while returning **no error** (the silent-0 trap: structured
// mode is case-insensitive, SPARQL text is not). These helpers canonicalize the
// local-name case for the three Little Big Brain namespaces so an MCP SPARQL query just works.
export const LBB_IRI_RE =
  /<https:\/\/littlebigbrain\.com\/(r|class|p)\/([^>]*)>/g;

/**
 * Lowercase the ASCII letters of a Little Big Brain IRI local part while leaving `%XX`
 * percent-escapes byte-for-byte (the projection's `encode_segment` emits *upper*
 * hex, e.g. `a%2Fb`, so lowercasing the escape would break the match). Real
 * relation names are identifiers like `FOR_CLIENT` with no escapes, so this is a
 * plain lowercase in the common case.
 */
export function lowercaseLocalName(local: string): string {
  let out = "";
  for (let i = 0; i < local.length; i += 1) {
    const ch = local[i];
    if (ch === "%" && /^[0-9A-Fa-f]{2}/.test(local.slice(i + 1, i + 3))) {
      out += local.slice(i, i + 3);
      i += 2;
    } else {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/**
 * Canonicalize the case of Little Big Brain relation/class/property IRI local names in a
 * SPARQL text query, and report each distinct rewrite so the change is never
 * hidden. Only touches angle-bracket IRIs under the three Little Big Brain namespaces, so
 * string literals and foreign IRIs (rdfs:label, foaf, …) are untouched. Because
 * the canonical form is already lowercase, an already-lowercase query is an
 * exact no-op (no rewrite, no note).
 */
export function normalizeLbbIris(query: string): {
  query: string;
  notes: string[];
} {
  const rewrites = new Map<string, string>();
  const normalized = query.replace(
    LBB_IRI_RE,
    (match, ns: string, local: string) => {
      const lowered = lowercaseLocalName(local);
      if (lowered === local) return match;
      const to = `<https://littlebigbrain.com/${ns}/${lowered}>`;
      rewrites.set(match, to);
      return to;
    },
  );
  const notes = [...rewrites.entries()].map(
    ([from, to]) =>
      `Normalized a Little Big Brain IRI to its canonical lowercase local name: ${from} → ${to}. ` +
      "Little Big Brain relation/class/property IRIs are always lowercased; the original case would have matched nothing.",
  );
  return { query: normalized, notes };
}

export function contentHashKey(
  scope: { graph?: string; branch?: string },
  payload: unknown,
): string {
  const digest = createHash("sha256")
    .update(
      stableJson({
        scope: { graph: scope.graph ?? null, branch: scope.branch ?? null },
        payload,
      }),
    )
    .digest("hex");
  return `mcp.commit:${digest}`;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`${name} is required`);
}

export function requireObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${name} is required`);
}

export function compactLimits(detail: Detail): {
  maxItems: number;
  maxString: number;
} {
  switch (detail) {
    case "full":
      return { maxItems: 100, maxString: 5_000 };
    case "standard":
      return { maxItems: 20, maxString: 1_000 };
    default:
      return { maxItems: 5, maxString: 300 };
  }
}

export function truncateValue(
  value: unknown,
  limits: { maxItems: number; maxString: number },
  state: { truncated: boolean },
): unknown {
  if (typeof value === "string") {
    if (value.length <= limits.maxString) return value;
    state.truncated = true;
    return `${value.slice(0, limits.maxString)}... [truncated ${value.length - limits.maxString} chars]`;
  }
  if (Array.isArray(value)) {
    const items =
      value.length > limits.maxItems ? value.slice(0, limits.maxItems) : value;
    if (items.length !== value.length) state.truncated = true;
    return items.map((item) => truncateValue(item, limits, state));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        truncateValue(v, limits, state),
      ]),
    );
  }
  return value;
}

export function countsFor(value: unknown): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  if (Array.isArray(value)) {
    counts.items = value.length;
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (Array.isArray(nested)) counts[key] = nested.length;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        for (const [childKey, child] of Object.entries(
          nested as Record<string, unknown>,
        )) {
          if (Array.isArray(child)) counts[`${key}.${childKey}`] = child.length;
        }
      }
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

export function defaultSummary(
  label: string,
  value: unknown,
  truncated: boolean,
): string {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { summary?: unknown }).summary === "string"
  ) {
    return (value as { summary: string }).summary;
  }
  const counts = countsFor(value);
  const countText = counts
    ? ` (${Object.entries(counts)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")})`
    : "";
  return `${label}${countText}${truncated ? " [truncated]" : ""}`;
}

export function envelope(
  label: string,
  value: unknown,
  detailArg?: string,
  next?: Record<string, unknown>,
) {
  const detail = normalizeDetail(detailArg);
  const state = { truncated: false };
  let data = truncateValue(value, compactLimits(detail), state);
  let result = {
    summary: defaultSummary(label, value, state.truncated),
    data,
    counts: countsFor(value),
    truncated: state.truncated || undefined,
    next:
      state.truncated && nextDetail(detail)
        ? { ...(next ?? {}), detail: nextDetail(detail) }
        : next,
  };

  let text = JSON.stringify(result, null, 2);
  if (text.length <= HARD_OUTPUT_CHARS) return result;

  const hardState = { truncated: true };
  data = truncateValue(value, { maxItems: 3, maxString: 120 }, hardState);
  result = {
    summary: `${label} [hard-capped for MCP output]`,
    data,
    counts: countsFor(value),
    truncated: true,
    next: { ...(next ?? {}), detail: "full" as const },
  };
  text = JSON.stringify(result, null, 2);
  if (text.length <= HARD_OUTPUT_CHARS) return result;

  return {
    summary: `${label} [hard-capped for MCP output]`,
    data: {
      note: "The response was too large for the MCP tool result. Narrow the query or request a smaller top_k.",
      preview: text.slice(0, 20_000),
    },
    counts: countsFor(value),
    truncated: true,
    next: { ...(next ?? {}), detail: "full" as const },
  };
}

export function queryEnvelope(
  label: string,
  value: unknown,
  detailArg: string | undefined,
  rowPage?: RowPage,
  next?: Record<string, unknown>,
  repage?: Omit<QueryCursor, "offset">,
) {
  const detail = normalizeDetail(detailArg);
  const limits = compactLimits(detail);
  const state = { truncated: false };
  const returned = rowPage?.returned;
  const rowCap = rowPage
    ? Math.max(limits.maxItems, rowPage.returned)
    : limits.maxItems;
  let data = truncateValue(value, { ...limits, maxItems: rowCap }, state);
  const partialRows = rowPage
    ? rowPage.returned < rowPage.total || rowPage.has_more
    : false;
  const rowText = rowPage
    ? rowPage.returned < rowPage.total
      ? `returned ${rowPage.returned} of ${rowPage.total} rows`
      : `returned ${rowPage.returned} rows`
    : undefined;
  const serverFlags = serverTruncationFlags(value);
  const serverTruncated = serverFlags.length > 0;
  const serverText = serverTruncated
    ? ` [server-truncated: ${serverFlags.join(", ")}]`
    : "";
  let result: Record<string, unknown> = {
    summary: rowText
      ? `${label}: ${rowText}${serverText}${state.truncated ? " [truncated output]" : ""}`
      : defaultSummary(label, value, state.truncated),
    data,
    counts: countsFor(value),
    row_page: rowPage,
    truncated: state.truncated || partialRows || serverTruncated || undefined,
    next:
      partialRows && next
        ? next
        : state.truncated && nextDetail(detail)
          ? { detail: nextDetail(detail) }
          : next,
  };

  let text = JSON.stringify(result, null, 2);
  if (text.length <= HARD_OUTPUT_CHARS) return result;

  // The full result overflows one MCP tool result, so the displayed rows are
  // capped to fit. `row_page`/`counts` still describe the *server* page, so
  // reporting only those reads as "every row delivered" even when the display
  // was cut — the recurring MCP false-positive. So: state shown-vs-returned
  // explicitly (`rows_shown`), and give advice that matches reality —
  //   * server itself withheld rows (partialRows): page with the existing cursor;
  //   * server returned the complete set but it is too big: page the same set at
  //     a smaller row_limit via a fresh cursor (offered here as `next`) or narrow
  //     with HAVING.
  // "page with the cursor" is never suggested unless a cursor is actually given.
  const remedy = partialRows
    ? " page with the cursor for the remaining rows"
    : repage
      ? " re-run with the returned cursor to page the full set at a smaller row_limit, or add a HAVING filter to narrow the groups"
      : " re-run with a lower row_limit to page the full set, or add a HAVING filter to narrow the groups";
  const capNote = (shown: number): string =>
    returned !== undefined && shown < returned
      ? ` [MCP showed ${shown} of ${returned} rows — over the ${HARD_OUTPUT_CHARS}-char output budget]`
      : " [hard-capped for MCP output]";
  for (const cap of [200, 100, 50, 25, 10, 5, 3]) {
    const hardState = { truncated: true };
    data = truncateValue(value, { maxItems: cap, maxString: 160 }, hardState);
    const shown = returned !== undefined ? Math.min(cap, returned) : cap;
    const hardNext = partialRows
      ? next
      : repage
        ? continuationNext(repage, shown, Math.max(1, shown))
        : undefined;
    result = {
      summary: rowText
        ? `${label}: ${rowText}${serverText}${capNote(shown)} —${remedy}`
        : `${label}${capNote(shown)} —${remedy}`,
      data,
      counts: countsFor(value),
      row_page: rowPage,
      rows_shown: returned !== undefined ? shown : undefined,
      truncated: true,
      next: hardNext,
    };
    text = JSON.stringify(result, null, 2);
    if (text.length <= HARD_OUTPUT_CHARS) return result;
  }

  return {
    summary: rowText
      ? `${label}: ${rowText}${serverText}${capNote(0)} —${remedy}`
      : `${label}${capNote(0)} —${remedy}`,
    data: {
      note: "The response was too large for the MCP tool result even at the minimum row cap. Page with a smaller row_limit or add a HAVING filter to narrow the groups.",
      preview: text.slice(0, 20_000),
    },
    counts: countsFor(value),
    row_page: rowPage,
    rows_shown: returned !== undefined ? 0 : undefined,
    truncated: true,
    next: partialRows
      ? next
      : repage
        ? continuationNext(repage, 0, 1)
        : undefined,
  };
}

export function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

// `lbb_inspect action=entity` returns the full incoming/outgoing/history arrays,
// but the display truncates them to the detail cap (compact shows 5) while
// `counts` still reports the true totals — so a high-degree node reads as "5
// edges" unless the caller already knows to switch to the paged `edges`/`history`
// reads. Make that self-documenting: when a sample is capped, attach the true
// counts plus ready-to-run paged reads so the workaround is discoverable in the
// response instead of tribal knowledge.
export function entityEdgeCapHint(
  data: unknown,
  detail: string | undefined,
  identity: Record<string, unknown>,
): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  const cap = compactLimits(normalizeDetail(detail)).maxItems;
  const lengthOf = (field: string): number => {
    const value = record[field];
    return Array.isArray(value) ? value.length : 0;
  };
  const capped: Record<string, number> = {};
  const fullReads: Record<string, unknown>[] = [];
  const edgeReads: {
    field: "incoming" | "outgoing";
    direction: "in" | "out";
  }[] = [
    { field: "incoming", direction: "in" },
    { field: "outgoing", direction: "out" },
  ];
  for (const { field, direction } of edgeReads) {
    const total = lengthOf(field);
    if (total > cap) {
      capped[field] = total;
      fullReads.push({
        tool: "lbb_inspect",
        arguments: { action: "edges", direction, ...identity },
      });
    }
  }
  if (lengthOf("history") > cap) {
    capped.history = lengthOf("history");
    fullReads.push({
      tool: "lbb_inspect",
      arguments: { action: "history", ...identity },
    });
  }
  if (Object.keys(capped).length === 0) return {};
  return {
    edge_sample: {
      note: `This node's edge/history arrays are a display sample capped at ${cap} per field; counts holds the true totals. Read the full set with these paged reads (cursor through them until has_more=false).`,
      capped_totals: capped,
      full_reads: fullReads,
    },
  };
}

export function errorResult(error: unknown) {
  const payload =
    error instanceof LbbError
      ? {
          type: error.type ?? "api_error",
          code: error.code ?? "unstructured_error",
          message: error.message,
          param: error.param ?? null,
          request_id: error.requestId ?? null,
          doc_url: error.docUrl ?? null,
          status: error.status,
        }
      : {
          type: "tool_error",
          code: "tool_error",
          message: error instanceof Error ? error.message : String(error),
          param: null,
          request_id: null,
          doc_url: null,
          status: null,
        };
  const structuredContent = { error: payload };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    isError: true as const,
  };
}

/**
 * A graph-scope 404 surfaces as a raw object-storage key
 * (`not found: tenants/<t>/graphs/<g>/branches/<b>/heads/current.json`), which
 * only means something if you already know the graph's real name. Rewrite it
 * into an actionable message: name the graph/branch this request targeted, and —
 * via the tenant-scoped `GET /v1/graphs`, which resolves even when the scoped
 * graph is absent — list the graphs (or branches) that do exist and tell the
 * caller to pass `graph=`/`branch=`. Every other error passes through untouched.
 */
export async function enrichError(
  client: LbbClient,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof LbbError) || error.status !== 404) return error;
  const match = /graphs\/([^/]+)\/branches\/([^/]+)\/heads\/current\.json/.exec(
    error.message,
  );
  if (!match) return error;
  const [, graph, branch] = match;
  let graphs: { graph_id: string; branches?: string[] }[] = [];
  try {
    const listed = (await client.listGraphs()) as {
      data?: { graph_id?: unknown; branches?: unknown }[];
    };
    graphs = (listed.data ?? []).flatMap((g) =>
      typeof g.graph_id === "string"
        ? [
            {
              graph_id: g.graph_id,
              branches: Array.isArray(g.branches)
                ? (g.branches as string[])
                : undefined,
            },
          ]
        : [],
    );
  } catch {
    // Listing failed too (auth, transport); fall back to the generic-but-actionable hint.
  }
  const existing = graphs.find((g) => g.graph_id === graph);
  let message: string;
  if (existing) {
    const branches = existing.branches ?? [];
    const list =
      branches.length > 0
        ? ` Existing branches: ${branches.slice(0, 50).join(", ")}.`
        : "";
    message =
      `branch "${branch}" was not found on graph "${graph}" in this tenant.${list} ` +
      "Pass an existing branch as the `branch` argument.";
  } else {
    const names = graphs.map((g) => g.graph_id);
    const list =
      names.length > 0
        ? ` Available graphs in this tenant: ${names.slice(0, 50).join(", ")}.`
        : "";
    const example = names.length > 0 ? ` (e.g. graph="${names[0]}")` : "";
    message =
      `graph "${graph}" was not found in this tenant — this request targeted graph "${graph}", branch "${branch}" ` +
      `(either you passed it or it is the connection default).${list} ` +
      `Pass an existing graph as the \`graph\` argument${example}.`;
  }
  return new LbbError(error.status, error.body, {
    type: error.type,
    code: error.code,
    message,
    param: error.param,
    request_id: error.requestId,
    doc_url: error.docUrl,
  });
}

export async function run(
  client: LbbClient,
  label: string,
  detail: string | undefined,
  fn: () => Promise<unknown>,
  augment?: (data: unknown) => Record<string, unknown>,
) {
  try {
    const data = await fn();
    const result = envelope(label, data, detail);
    return toolResult(augment ? { ...result, ...augment(data) } : result);
  } catch (error) {
    return errorResult(await enrichError(client, error));
  }
}

/**
 * Point-of-use feedback affordance attached to every `lbb_search` result: an
 * agent looking at results it can judge gets a ready-to-run
 * `lbb_commit mode=search_feedback` template (the standout "guide ships runnable
 * possibilities" pattern, applied to the moment of judgment). The `search_id` is
 * pre-filled from the response when present so the label set ties back to this
 * exact ranked run.
 */
export function searchFeedbackHint(
  data: unknown,
  ctx: { query?: string; queries?: string[]; graph?: string; branch?: string },
): Record<string, unknown> {
  const searchId =
    data &&
    typeof data === "object" &&
    typeof (data as { search_id?: unknown }).search_id === "string"
      ? (data as { search_id: string }).search_id
      : undefined;
  return {
    how: "If you can judge these results, rate them with lbb_commit mode=search_feedback. Little Big Brain stores the labels as customer-specific qrels (in __lbb_feedback) and exports them as training/eval data for embedding fine-tuning — they improve retrieval, and are kept separate from customer facts. Skip it when you have no basis to judge.",
    grades: { ideal_or_good: 3, partially_relevant: 1, bad: 0 },
    example: {
      tool: "lbb_commit",
      args: {
        mode: "search_feedback",
        ...(ctx.graph !== undefined ? { graph: ctx.graph } : {}),
        ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}),
        search_feedback: {
          query: ctx.query ?? ctx.queries?.[0] ?? "<the query you ran>",
          ...(searchId !== undefined ? { search_id: searchId } : {}),
          labels: [
            {
              target: {
                kind: "entity",
                entity: { entity_type: "<type>", name: "<name>" },
              },
              rank: 1,
              score: 0.0,
              grade: 3,
            },
          ],
          split: "unspecified",
        },
      },
    },
  };
}

export function resolveProfile(profile?: string): string | undefined {
  switch (profile) {
    case "ndcg_v1":
    case "graph_aware_v1":
    case "scored_atom_v1":
    case "baseline":
      return profile;
    default:
      return undefined;
  }
}

export function searchBody(p: {
  query: string;
  mode?: string;
  top_k?: number;
  profile?: string;
  as_of?: string;
  as_of_commit_seq?: number;
}): Record<string, unknown> {
  const mode = p.mode ?? "hybrid";
  return {
    query: p.query,
    targets: ["concepts", "entities", "assertions", "paths", "observations"],
    search: {
      lexical: mode === "hybrid" || mode === "lexical",
      bm25: mode === "hybrid" || mode === "bm25",
      vector: mode === "hybrid" || mode === "vector",
      bm25_source: "persisted",
      vector_source: "persisted",
      consistency: "strong",
      profile: resolveProfile(p.profile),
    },
    max_hops: 2,
    top_k: p.top_k ?? 10,
    ...(p.as_of !== undefined ? { as_of_valid_time: p.as_of } : {}),
    ...(p.as_of_commit_seq !== undefined
      ? { as_of_commit_seq: p.as_of_commit_seq }
      : {}),
    explain: false,
  };
}

export function vegaChart(
  kind: "bar" | "pie",
  title: string,
  points: ChartPoint[],
  categoryTitle: string,
  valueTitle: string,
): unknown {
  const base = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title,
    data: { values: points },
  };
  if (kind === "pie") {
    return {
      ...base,
      mark: { type: "arc", tooltip: true },
      encoding: {
        theta: { field: "value", type: "quantitative", title: valueTitle },
        color: { field: "label", type: "nominal", title: categoryTitle },
      },
    };
  }
  return {
    ...base,
    mark: { type: "bar", tooltip: true },
    encoding: {
      x: { field: "label", type: "nominal", sort: "-y", title: categoryTitle },
      y: { field: "value", type: "quantitative", title: valueTitle },
    },
  };
}

export function sparqlScalarNumber(scalar: unknown): number {
  if (scalar == null || scalar === "null") return 0;
  if (typeof scalar === "object") {
    const s = scalar as { i64?: number; f64?: number };
    if (typeof s.i64 === "number") return s.i64;
    if (typeof s.f64 === "number") return s.f64;
  }
  return 0;
}

export function entityLabel(view: unknown): string {
  if (view && typeof view === "object") {
    const v = view as { name?: string; id?: string };
    return v.name ?? v.id ?? "(unnamed)";
  }
  return String(view ?? "(unnamed)");
}

/** Label for a typed scalar GROUP BY key (`value_keys[as]`), an externally
 * tagged `SparqlKeyValue` such as `{ str: "search" }`, `{ i64: 5 }`,
 * `{ date_time: "2026-06" }`, or the unit `"null"`. */
export function sparqlKeyLabel(value: unknown): string {
  if (value == null || value === "null") return "null";
  if (typeof value === "object") {
    const entry = Object.entries(value as Record<string, unknown>)[0];
    if (entry) return String(entry[1]);
  }
  return String(value);
}

export function buildPossibilities(
  relations: NamedCount[],
  entityTypes: NamedCount[] = [],
): unknown[] {
  const possibilities: unknown[] = [
    {
      name: "Entity composition",
      description:
        "How many entities of each type - the overall shape of the graph.",
      chart: "bar",
      run: {
        tool: "lbb_query",
        args: { mode: "analyze", metric: "entity_types" },
      },
    },
    {
      name: "Relation usage",
      description: "How many edges per relation - which connections dominate.",
      chart: "bar",
      run: {
        tool: "lbb_query",
        args: { mode: "analyze", metric: "relations" },
      },
    },
    {
      name: "Overview",
      description: "Top-line totals: entities, current edges, observations.",
      chart: "bar",
      run: { tool: "lbb_query", args: { mode: "analyze", metric: "overview" } },
    },
  ];
  const top = relations[0]?.name;
  if (top) {
    possibilities.push(
      {
        name: `Hubs in ${top}`,
        description: `For the relation ${top}, how many distinct targets each source connects to (top 20).`,
        chart: "bar",
        run: {
          tool: "lbb_query",
          args: {
            mode: "structured",
            body: {
              patterns: [
                { subject: { var: "s" }, predicate: top, object: { var: "o" } },
              ],
              group_by: ["s"],
              aggregates: [
                {
                  func: "count",
                  distinct: true,
                  operand: { var: "o" },
                  as: "n",
                },
              ],
              order_by: [{ var: "n", descending: true }],
              limit: 20,
            },
          },
        },
      },
      {
        name: `Most-referenced targets in ${top}`,
        description: `For the relation ${top}, which targets are pointed at by the most sources (top 20).`,
        chart: "bar",
        run: {
          tool: "lbb_query",
          args: {
            mode: "structured",
            body: {
              patterns: [
                { subject: { var: "s" }, predicate: top, object: { var: "o" } },
              ],
              group_by: ["o"],
              aggregates: [
                {
                  func: "count",
                  distinct: true,
                  operand: { var: "s" },
                  as: "n",
                },
              ],
              order_by: [{ var: "n", descending: true }],
              limit: 20,
            },
          },
        },
      },
    );
  }
  const topType = entityTypes[0]?.name;
  if (top && topType) {
    possibilities.push({
      name: `${topType} nodes that participate in ${top}`,
      description: `Select every ${topType} that is the source of at least one ${top} edge.`,
      chart: "bar",
      run: {
        tool: "lbb_query",
        args: {
          mode: "shacl",
          shapes: [
            {
              targetClass: topType,
              property: [{ path: top, min_count: 1, bind: "targets" }],
            },
          ],
        },
      },
    });
  }
  return possibilities;
}

export async function guide(
  scopedClient: LbbClient,
): Promise<Record<string, unknown>> {
  const s = (await scopedClient.summary()) as {
    entity_count?: number;
    current_edge_count?: number;
    observation_count?: number;
    edge_event_count?: number;
    entity_types?: NamedCount[];
    relations?: NamedCount[];
  };
  const entityTypes = [...(s.entity_types ?? [])].sort(
    (a, b) => b.count - a.count,
  );
  const relations = [...(s.relations ?? [])].sort((a, b) => b.count - a.count);
  return {
    overview: {
      entities: s.entity_count ?? 0,
      current_edges: s.current_edge_count ?? 0,
      observations: s.observation_count ?? 0,
      edge_events: s.edge_event_count ?? 0,
    },
    entity_types: entityTypes,
    relations,
    capability: {
      search:
        "Use lbb_search for natural-language retrieval, optional multi-query fusion, and optional path following.",
      search_feedback:
        "After a lbb_search result set is useful or clearly wrong, write relevance labels with lbb_commit mode=search_feedback. Use grade 3 for ideal/good results, grade 1 for partially relevant results, and grade 0 for bad results. Include the original query, search_id when present, target identity, rank, score, and an optional split train/eval/unspecified. These labels are stored in __lbb_feedback/main and later exported as qrels-style training/eval data; they are not customer facts.",
      inspect:
        "Use lbb_inspect for ontology, RDF/SHACL schema, stored rules, metadata, state/history/why, exact traversals, and this guide.",
      ontology_decorations:
        "lbb_inspect action=ontology returns a decoration_status catalog: each ontology decoration is enforced (the engine acts on it — state_reducer, value_type, super_types, properties, supernode_policy; cardinality, which GET /v1/ontology/conformance audits as sh:maxCount; and inverse_name/symmetric, which SPARQL resolves as relation aliases — an inverse name is queryable directly (lowered to ^forward, no stored inverse triple) and a symmetric relation matches both directions), advisory (transitive, temporal_semantics, required), or reserved (stored but unwired — default_weight, resolvable, alias/embedding_fields). You can also always reverse any relation in SPARQL by flipping the triple pattern or using ^forward. Each relation_def also carries edge_count — the number of current edges of that relation in this branch's snapshot — so you can tell at a glance which declared relations are actually populated (edge_count 0 = declared but unused) without a separate summary call.",
      query:
        'Use lbb_query for structured SPARQL-subset bodies, SPARQL text, SHACL shapes, inference previews, retrieval premises, and canned analysis. A mode=structured body is { patterns: [{ subject, predicate, object }], filters?, group_by?, group_keys?, aggregates?, having? }; a pattern `predicate` is a relation name and is case-insensitive. mode=structured GROUP BY is not limited to entity identity: group_keys can key on a typed scalar property ({ property: { var, field, as } }) or a calendar bucket of a datetime property ({ date_bucket: { var, field, granularity: month|day|…, as } }), with scalar keys returned per group under value_keys[as] — so per-category breakdowns (e.g. by area) and time series (e.g. commits per month) are single server-side queries over typed attributes, not 700 entity fetches bucketed by hand. These typed scalar attributes are set via entity_properties and read back flat under attributes on entity/list reads (there is no nested metadata.attributes blob); discover the queryable field names via lbb_inspect action=ontology (property_defs) or action=schema, and see the lbb_query body field for a copy-paste commits-per-area-per-month example. A FILTER entry has the exact shape { compare: { op: eq|ne|lt|le|gt|ge, left: <term>, right: <term> } } (also and/or/not), where a <term> is { var }, { property: { var, field } }, or { value: { str|i64|f64|bool|date_time|entity } } — e.g. filters: [{ compare: { op: "ge", left: { property: { var: "d", field: "amount" } }, right: { value: { f64: 1000000 } } } }]. In SPARQL text, relations are <https://littlebigbrain.com/r/NAME> (NAME lowercased; reverse with ^) and types <https://littlebigbrain.com/class/NAME> used as `?x a <…/class/NAME>` — the local name is always lowercase, and the tool auto-lowercases /r/, /class/, /p/ IRI local names (noting each rewrite) so a stray uppercase does not silently match nothing; entities are content-addressed, so match a named entity by `?e <http://www.w3.org/2000/01/rdf-schema#label> "Name"` rather than constructing its IRI. Off-graph, a stack also serves the native SPARQL 1.1 Protocol at /sparql for off-the-shelf SPARQL clients.',
      write:
        "Use lbb_commit for fact writes and search relevance feedback; omitted idempotency keys are content-derived so retries dedupe. Set typed scalar attributes via entity_properties once the field is registered (add it on a live graph with lbb_configure evolve_ontology add_property). For feedback, use mode=search_feedback rather than fact triplets.",
      configure:
        "Use lbb_configure to define a new ontology, evolve an existing one in place (add_entity_type / add_relation / add_property / widen, rename, narrow/remove), publish a previewed RDF/SHACL schema bundle, or replace stored rules after previewing them with lbb_query mode=infer.",
      inference:
        "Rule body/head terms are { var } or { entity: { entity_type, name } } — a fixed entity lets a rule match or derive a constant value (e.g. a status). A not_exists combinator adds stratified negation for universal conditions. Roll-up example: rule 1 head { var: phase } HAS_INCOMPLETE_DELIVERABLE { var: d }, body phase HAS_DELIVERABLE d, not_exists [ d HAS_DELIVERY_STATUS { entity: DeliveryStatus/Complete } ]; rule 2 head phase HAS_ROLLUP_STATUS { entity: DeliveryStatus/Complete }, body phase HAS_DELIVERABLE any, not_exists [ phase HAS_INCOMPLETE_DELIVERABLE x ] — derives complete only when every deliverable is complete.",
    },
    possibilities: buildPossibilities(relations, entityTypes),
    how_to:
      "Ground with lbb_inspect action=guide, retrieve with lbb_search, rate useful/partial/bad retrieval results with lbb_commit mode=search_feedback when you have a judgment, inspect exact entities/schema/rules with lbb_inspect, preview analysis or inference with lbb_query, then write graph facts with lbb_commit or configuration with lbb_configure only when intended.",
  };
}

export async function analyze(
  scopedClient: LbbClient,
  p: {
    metric?: string;
    chart?: string;
    top_k?: number;
    query?: string;
    field?: string;
    sparql?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const metric = requireString(p.metric, "metric");
  const chart = p.chart === "pie" ? "pie" : "bar";
  let title: string;
  let categoryTitle: string;
  let valueTitle = "count";
  let points: ChartPoint[];

  if (
    metric === "entity_types" ||
    metric === "relations" ||
    metric === "overview"
  ) {
    const s = (await scopedClient.summary()) as {
      entity_count?: number;
      current_edge_count?: number;
      observation_count?: number;
      edge_event_count?: number;
      entity_types?: { name: string; count: number }[];
      relations?: { name: string; count: number }[];
    };
    if (metric === "entity_types") {
      title = "Entities by type";
      categoryTitle = "entity type";
      points = (s.entity_types ?? []).map((r) => ({
        label: r.name,
        value: r.count,
      }));
    } else if (metric === "relations") {
      title = "Edges by relation";
      categoryTitle = "relation";
      points = (s.relations ?? []).map((r) => ({
        label: r.name,
        value: r.count,
      }));
    } else {
      title = "Graph overview";
      categoryTitle = "metric";
      points = [
        { label: "entities", value: s.entity_count ?? 0 },
        { label: "current edges", value: s.current_edge_count ?? 0 },
        { label: "observations", value: s.observation_count ?? 0 },
        { label: "edge events", value: s.edge_event_count ?? 0 },
      ];
    }
  } else if (metric === "facets") {
    const field = requireString(p.field, "field");
    const res = (await scopedClient.graphSearch({
      query: p.query ?? "",
      targets: ["entities", "assertions", "observations"],
      search: {
        lexical: true,
        bm25: true,
        vector: true,
        bm25_source: "persisted",
        vector_source: "persisted",
        consistency: "strong",
      },
      facets: [{ field }],
      max_hops: 1,
      top_k: 50,
      explain: false,
    } as never)) as {
      facets?: { field: string; buckets: { value: string; count: number }[] }[];
    };
    const facet =
      (res.facets ?? []).find((f) => f.field === field) ??
      (res.facets ?? [])[0];
    title = `${p.query ? `"${p.query}"` : "All"} by ${field}`;
    categoryTitle = field;
    points = (facet?.buckets ?? []).map((b) => ({
      label: b.value,
      value: b.count,
    }));
  } else if (metric === "sparql") {
    const body = requireObject(p.sparql, "sparql");
    const res = (await scopedClient.sparql(body as never)) as {
      groups?: {
        keys: Record<string, unknown>;
        value_keys?: Record<string, unknown>;
        aggregates: Record<string, unknown>;
      }[];
    };
    const groups = res.groups ?? [];
    const first = groups[0];
    // Prefer an entity-identity key; otherwise a typed scalar key — property and
    // date-bucket grouping return the key under value_keys, not keys.
    const entityKeyVar = Object.keys(first?.keys ?? {})[0];
    const scalarKeyVar = entityKeyVar
      ? undefined
      : Object.keys(first?.value_keys ?? {})[0];
    const keyVar = entityKeyVar ?? scalarKeyVar;
    const aggVar = Object.keys(first?.aggregates ?? {})[0];
    title = aggVar ? `${aggVar} by ${keyVar ?? "group"}` : "Aggregation";
    categoryTitle = keyVar ?? "group";
    valueTitle = aggVar ?? "value";
    points = groups.map((g) => ({
      label: entityKeyVar
        ? entityLabel(g.keys[entityKeyVar])
        : scalarKeyVar
          ? sparqlKeyLabel(g.value_keys?.[scalarKeyVar])
          : "(all)",
      value: aggVar ? sparqlScalarNumber(g.aggregates[aggVar]) : 0,
    }));
  } else {
    throw new Error(
      "metric must be one of entity_types, relations, overview, facets, sparql",
    );
  }

  points.sort((a, b) => b.value - a.value);
  if (typeof p.top_k === "number" && p.top_k > 0)
    points = points.slice(0, p.top_k);
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const summary = points.length
    ? `${title}: ${points.length} categories, total ${total.toLocaleString()}. Top: ${points
        .slice(0, 3)
        .map((point) => `${point.label} (${point.value.toLocaleString()})`)
        .join(", ")}.`
    : `${title}: no data.`;

  return {
    title,
    metric,
    summary,
    data: points,
    chart: vegaChart(chart, title, points, categoryTitle, valueTitle),
  };
}

export function ontologyDefineBody(p: {
  entity_types?: unknown[];
  relations?: unknown[];
  source?: string;
  format?: string;
  merge_default?: boolean;
}): Record<string, unknown> {
  if (p.source !== undefined) {
    return {
      source: p.source,
      format: p.format ?? "auto",
      merge_default: p.merge_default ?? false,
    };
  }
  if (!p.entity_types?.length || !p.relations?.length) {
    throw new Error(
      "provide both entity_types and relations, or a raw `source` document",
    );
  }
  return {
    source: JSON.stringify({
      entity_types: p.entity_types,
      relation_types: p.relations,
    }),
    format: "spec",
    merge_default: p.merge_default ?? false,
  };
}

export function schemaSourceBody(source?: {
  source: string;
  format?: string;
}): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  return {
    source: source.source,
    format: source.format ?? "auto",
  };
}

export function schemaPreviewBody(p: {
  ontology?: { source: string; format?: string };
  shapes?: { source: string; format?: string };
  base_ontology_version?: number;
  base_shapes_version?: number;
  desired_mode?: string;
}): Record<string, unknown> {
  const ontology = schemaSourceBody(p.ontology);
  const shapes = schemaSourceBody(p.shapes);
  if (ontology === undefined && shapes === undefined) {
    throw new Error("schema_preview requires an ontology or shapes source");
  }
  return {
    ontology,
    shapes,
    base_ontology_version: p.base_ontology_version ?? null,
    base_shapes_version: p.base_shapes_version ?? null,
    desired_mode: p.desired_mode ?? "warn",
  };
}

export function schemaPublishBody(p: {
  preview_digest: string;
  ontology?: { source: string; format?: string };
  shapes: { source: string; format?: string };
  desired_mode: string;
  confirm_restrictive?: boolean;
}): Record<string, unknown> {
  return {
    preview_digest: p.preview_digest,
    ontology: schemaSourceBody(p.ontology),
    shapes: schemaSourceBody(p.shapes),
    desired_mode: p.desired_mode,
    confirm_restrictive: p.confirm_restrictive ?? false,
  };
}

export function choosePublishMode(
  response: Record<string, unknown>,
  requested: string,
): "warn" | "reject" | undefined {
  const modes = Array.isArray(response.publish_mode_allowed)
    ? response.publish_mode_allowed
    : [];
  if (modes.includes(requested))
    return requested === "reject" ? "reject" : "warn";
  if (modes.includes("warn")) return "warn";
  if (modes.includes("reject")) return "reject";
  return undefined;
}

export function auditSummary(
  audit: unknown,
): Record<string, unknown> | undefined {
  if (!audit || typeof audit !== "object") return undefined;
  const a = audit as {
    conforms?: unknown;
    result_count?: unknown;
    messages?: unknown;
    results?: unknown;
  };
  return {
    conforms: a.conforms,
    result_count: a.result_count,
    messages: a.messages,
    sample_results: Array.isArray(a.results)
      ? a.results.slice(0, 5)
      : undefined,
  };
}

export async function schemaPreview(
  target: LbbClient,
  p: {
    graph?: string;
    branch?: string;
    ontology?: { source: string; format?: string };
    shapes?: { source: string; format?: string };
    base_ontology_version?: number;
    base_shapes_version?: number;
    desired_mode?: string;
  },
): Promise<Record<string, unknown>> {
  const body = schemaPreviewBody(p);
  const response = (await target.schema.preview(body as never)) as Record<
    string,
    unknown
  >;
  const desiredMode =
    typeof response.desired_mode === "string"
      ? response.desired_mode
      : String(body.desired_mode);
  const publishMode = choosePublishMode(response, desiredMode);
  const suggestedPublish =
    publishMode && body.shapes
      ? {
          tool: "lbb_configure",
          args: {
            action: "publish_schema",
            graph: p.graph,
            branch: p.branch,
            preview_digest: response.preview_digest,
            desired_mode: publishMode,
            confirm_restrictive:
              response.verdict === "restrictive" && publishMode === "warn"
                ? true
                : undefined,
            ontology: body.ontology,
            shapes: body.shapes,
          },
        }
      : undefined;
  return {
    graph: response.graph,
    verdict: response.verdict,
    can_publish: response.can_publish,
    publish_mode_allowed: response.publish_mode_allowed,
    preview_digest: response.preview_digest,
    desired_mode: response.desired_mode,
    proposed_ontology_version: response.proposed_ontology_version,
    proposed_shapes_version: response.proposed_shapes_version,
    diff: response.diff,
    audit: auditSummary(response.audit),
    messages: response.messages,
    suggested_publish_schema: suggestedPublish,
  };
}

/**
 * Register the hard-break v2 Little Big Brain tool belt on an MCP server. The surface is
 * task-oriented for agents; each tool dispatches to the existing @littlebigbrain/client
 * routes without adding new HTTP or SDK APIs.
 */
