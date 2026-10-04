import type { LbbClient } from "@littlebigbrain/client";
import { QUESTION_MAX_ROWS, type QueryCursor } from "./tool-contracts.js";
import {
  defaultRowLimit,
  normalizeDetail,
  queryEnvelope,
  queryToolResult,
  rowPageFrom,
  rowPageNext,
  scoped,
} from "./tool-runtime.js";

// The request and response of `POST /v1/query/rewrite`, as this tool sends and
// reads them. They are local types, so the package builds against a client
// release whose generated schema does not name the route yet.

type QuestionRoute =
  "lookup" | "aggregate" | "search" | "history" | "schema" | "unanswerable";

type Entailment = "none" | "subclass" | "rdfs" | "owl";

interface QuestionRequest {
  question: string;
  context?: string;
  route?: QuestionRoute;
  run: boolean;
  limit?: number;
}

interface QuestionResponse {
  route: {
    kind: QuestionRoute;
    confidence: number;
    by: "caller" | "router" | "rewriter";
  };
  query?: {
    sparql: string;
    entailment: Entailment;
    as_of_commit_seq?: number | null;
  } | null;
  history?: { as_of_date?: string | null; compare: boolean } | null;
  rationale: string;
  result?: {
    results: string;
    row_page?: unknown;
    snapshot?: { served_at_seq?: number | null } | null;
    trace_id?: string | null;
  } | null;
  error?: string | null;
  attempts: number;
}

export interface QuestionArgs {
  question: string;
  context?: string;
  route?: QuestionRoute;
  limit?: number;
  run?: boolean;
  detail?: string;
  graph?: string;
}

/**
 * `lbb_query mode=question`: the server turns the question into a SPARQL
 * query and, by default, runs it. The rows are bounded as `mode=sparql`
 * bounds them, and `next` continues the same query with `mode=sparql`.
 */
export async function answerQuestion(
  client: LbbClient,
  args: QuestionArgs,
  textFormat?: "compact" | "pretty",
) {
  const detail = normalizeDetail(args.detail);
  const run = args.run ?? true;
  const rowLimit = Math.min(
    args.limit ?? defaultRowLimit(detail),
    QUESTION_MAX_ROWS,
  );
  const target = scoped(client, args.graph);
  const body: QuestionRequest = {
    question: args.question,
    ...(args.context !== undefined ? { context: args.context } : {}),
    ...(args.route !== undefined ? { route: args.route } : {}),
    run,
    ...(run ? { limit: rowLimit } : {}),
  };
  // Each call uses model tokens, and the server corrects a failing query
  // once, so a failed call is not retried.
  const response = await target.request<QuestionResponse>(
    "POST",
    "/v1/query/rewrite",
    {
      body,
      retry: false,
      query: { consistency: target.defaultConsistency },
    },
  );

  const { route, query, result } = response;
  const traceId = result?.trace_id ?? null;
  const answer: Record<string, unknown> = {
    route: { kind: route.kind, confidence: route.confidence, by: route.by },
    rationale: response.rationale,
    sparql: query?.sparql ?? null,
    entailment: query?.entailment ?? null,
    ...(typeof query?.as_of_commit_seq === "number"
      ? { as_of_commit_seq: query.as_of_commit_seq }
      : {}),
    ...(response.history ? { history: response.history } : {}),
    error: response.error ?? null,
    trace_id: traceId,
    attempts: response.attempts,
  };
  const notes: string[] = [];
  if (traceId) {
    notes.push(
      `eval trace ${traceId}: to label rows, read their item ids with lbb_evals action=trace trace_id=${traceId}, then call lbb_evals action=label trace_id=${traceId} item=<id> valid=true|false (or items=[…]).`,
    );
  }
  if (response.history?.as_of_date) {
    notes.push(
      `The question names the date ${response.history.as_of_date}. Find the commit of that date, then run the query with lbb_query mode=sparql as_of_commit_seq=<commit>.`,
    );
  }
  if (response.error && query) {
    notes.push(
      "The last query failed (see error). Correct it and run it with lbb_query mode=sparql, or ask again with more context.",
    );
  }
  const label = `lbb_query.question: route ${route.kind} (${route.by}, confidence ${route.confidence.toFixed(2)})`;

  const data = result
    ? (JSON.parse(result.results) as Record<string, unknown>)
    : undefined;
  const rowPage = result ? rowPageFrom(result) : undefined;
  const bindings = (data?.results as { bindings?: unknown } | undefined)
    ?.bindings;
  if (data && rowPage && query && Array.isArray(bindings)) {
    // The same query continues with mode=sparql at the commit the run read.
    const pin = query.as_of_commit_seq ?? result?.snapshot?.served_at_seq;
    const cursorBase: Omit<QueryCursor, "offset"> = {
      v: 1,
      mode: "sparql",
      graph: args.graph,
      detail,
      row_limit: rowLimit,
      query: query.sparql,
      entailment: query.entailment,
      ...(typeof pin === "number" ? { as_of_commit_seq: pin } : {}),
    };
    return queryToolResult(
      queryEnvelope(
        label,
        { ...answer, ...data },
        detail,
        rowPage,
        rowPageNext(cursorBase, rowPage),
        cursorBase,
        { textFormat, notes },
      ),
      textFormat,
    );
  }
  // No rows to page: the query only, an ASK answer, or no query at all. The
  // query text is returned whole.
  const summary = data
    ? `${label}: ran the query`
    : query
      ? `${label}: ${response.error ? "the query failed" : "the query, not run"}`
      : `${label}: no query`;
  return queryToolResult(
    {
      summary,
      data: { ...answer, ...(data ?? {}) },
      ...(rowPage ? { row_page: rowPage } : {}),
      ...(notes.length ? { notes } : {}),
    },
    textFormat,
  );
}
