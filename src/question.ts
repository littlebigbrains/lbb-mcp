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
  anchor?: string[];
  timeline?: TimelinePoint[];
}

/** A date and the commit that holds the graph as it was then. */
interface TimelinePoint {
  date: string;
  as_of_commit_seq: number;
  label?: string;
}

/** One value of a row, as SPARQL 1.1 Query Results JSON writes it. */
interface QuestionTerm {
  type: string;
  value: string;
  datatype?: string | null;
  "xml:lang"?: string | null;
}

/** Where a history question read the graph, and what a comparison found. */
interface QuestionHistory {
  as_of_date?: string | null;
  compare: boolean;
  as_of_commit_seq?: number | null;
  resolved_by?: "commit_time" | "timeline" | "request" | null;
  label?: string | null;
  before?: unknown;
  after?: unknown;
  added?: Record<string, QuestionTerm>[] | null;
  removed?: Record<string, QuestionTerm>[] | null;
  truncated?: boolean;
}

/** A name of the question the server linked to an entity. */
interface QuestionLink {
  text: string;
  iri: string;
  label?: string | null;
  class: string;
  score: number;
  by: string;
}

/** What the server read about one anchored IRI. */
interface QuestionAnchor {
  iri: string;
  found: boolean;
  label?: string | null;
  types?: string[];
  note?: string | null;
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
  history?: QuestionHistory | null;
  rationale: string;
  result?: {
    results: string;
    row_page?: unknown;
    snapshot?: { served_at_seq?: number | null } | null;
    trace_id?: string | null;
  } | null;
  error?: string | null;
  attempts: number;
  linked?: QuestionLink[];
  anchors?: QuestionAnchor[];
}

export interface QuestionArgs {
  question: string;
  context?: string;
  route?: QuestionRoute;
  limit?: number;
  run?: boolean;
  anchor?: string[];
  timeline?: TimelinePoint[];
  detail?: string;
  graph?: string;
}

/**
 * Progress of one question: the tool call asked for it with a
 * `_meta.progressToken`. `report` sends one MCP progress notification.
 */
export interface QuestionProgress {
  /** Stops the server's work when the tool call is cancelled. */
  signal?: AbortSignal;
  report(progress: number, message: string): Promise<void>;
}

/** One event of a streamed rewrite, as this tool reads it. */
type StreamEvent = { event: string; data: unknown };

const REPAIR_ERROR_CHARS = 200;

/** The progress message of a stream event, in short plain words. */
export function progressMessage(event: StreamEvent): string | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.event) {
    case "grounding":
      return "Read the graph description";
    case "route": {
      const confidence =
        typeof data.confidence === "number"
          ? `, ${data.confidence.toFixed(2)}`
          : "";
      return `Route: ${String(data.kind)} (${String(data.by)}${confidence})`;
    }
    case "query":
      return `Wrote query ${String(data.attempt ?? 1)}`;
    case "run":
      return data.point === "before"
        ? "Running the query at the earlier point"
        : data.point === "after"
          ? "Running the query at the later point"
          : "Running the query";
    case "rows": {
      const count = Number(data.count);
      return `${count} ${count === 1 ? "row" : "rows"} in ${String(data.ms)} ms`;
    }
    case "repair": {
      const error = String(data.error ?? "");
      const shown =
        error.length > REPAIR_ERROR_CHARS
          ? `${error.slice(0, REPAIR_ERROR_CHARS - 1)}…`
          : error;
      return `Correcting the query: ${shown}`;
    }
    default:
      return undefined;
  }
}

type RewriteStream = (
  body: QuestionRequest,
  opts: { signal?: AbortSignal },
) => AsyncIterable<StreamEvent>;

/**
 * The rewrite as a stream of progress events. Each event becomes one
 * progress notification; the `done` event is the same response as the call
 * without a stream. A client release without `query.rewriteStream` answers
 * without progress.
 */
async function streamedRewrite(
  target: LbbClient,
  body: QuestionRequest,
  progress: QuestionProgress,
): Promise<QuestionResponse | undefined> {
  const query = target.query as unknown as { rewriteStream?: RewriteStream };
  if (typeof query.rewriteStream !== "function") return undefined;
  let step = 0;
  for await (const event of query.rewriteStream.call(target.query, body, {
    signal: progress.signal,
  })) {
    if (event.event === "done") return event.data as QuestionResponse;
    const message = progressMessage(event);
    if (message === undefined) continue;
    step += 1;
    // A lost notification never fails the question.
    await progress.report(step, message).catch(() => undefined);
  }
  throw new Error("the rewrite stream ended before its done event");
}

/** A row of a comparison as `{ variable: lexical value }`. */
function lexicalRow(row: Record<string, QuestionTerm>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([name, term]) => [name, term.value]),
  );
}

/**
 * The history the tool returns: where the question read the graph, and for
 * a comparison the rows that differ as lexical values. The two runs stay
 * out: the later one is the result, and the rows that differ say what the
 * earlier one held.
 */
function historyView(history: QuestionHistory): Record<string, unknown> {
  const view: Record<string, unknown> = { ...history };
  delete view.before;
  delete view.after;
  if (history.added) view.added = history.added.map(lexicalRow);
  if (history.removed) view.removed = history.removed.map(lexicalRow);
  return view;
}

/** What the agent should know about the history of the answer. */
function historyNotes(history: QuestionHistory | null | undefined): string[] {
  if (!history) return [];
  const notes: string[] = [];
  const point =
    typeof history.as_of_commit_seq === "number"
      ? `commit ${history.as_of_commit_seq}${history.label ? ` (${history.label})` : ""}`
      : undefined;
  if (history.as_of_date && point) {
    const by =
      history.resolved_by === "timeline"
        ? "the timeline"
        : history.resolved_by === "commit_time"
          ? "the commit times"
          : "the request";
    notes.push(
      `The question names ${history.as_of_date}; the server read ${point}, found by ${by}.`,
    );
  } else if (history.as_of_date) {
    notes.push(
      `The server could not place ${history.as_of_date} (see error). Pass timeline=[{date, as_of_commit_seq}] to name the commit of each date, or run the query with lbb_query mode=sparql as_of_commit_seq=<commit>.`,
    );
  }
  if (history.compare && history.added && point) {
    notes.push(
      `A comparison: the rows are the later run; history.added and history.removed hold the rows that changed since ${point}.${history.truncated ? " The difference is not complete: a run returned only its first rows, or more than 500 rows changed." : ""}`,
    );
  }
  return notes;
}

/**
 * `lbb_query mode=question`: the server turns the question into a SPARQL
 * query and, by default, runs it. The rows are bounded as `mode=sparql`
 * bounds them, and `next` continues the same query with `mode=sparql`.
 * With `progress`, the server streams its steps and each step is reported;
 * the result is the same.
 */
export async function answerQuestion(
  client: LbbClient,
  args: QuestionArgs,
  textFormat?: "compact" | "pretty",
  progress?: QuestionProgress,
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
    ...(args.anchor?.length ? { anchor: args.anchor } : {}),
    ...(args.timeline?.length ? { timeline: args.timeline } : {}),
  };
  // Each call uses model tokens, and the server corrects a failing query
  // once, so a failed call is not retried.
  const response =
    (progress ? await streamedRewrite(target, body, progress) : undefined) ??
    (await target.request<QuestionResponse>("POST", "/v1/query/rewrite", {
      body,
      retry: false,
      query: { consistency: target.defaultConsistency },
    }));

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
    ...(response.history ? { history: historyView(response.history) } : {}),
    error: response.error ?? null,
    trace_id: traceId,
    attempts: response.attempts,
    ...(response.linked?.length ? { linked: response.linked } : {}),
    ...(response.anchors?.length ? { anchors: response.anchors } : {}),
  };
  const notes: string[] = [];
  for (const anchor of response.anchors ?? []) {
    if (anchor.note) {
      notes.push(`anchor ${anchor.iri}: ${anchor.note}.`);
    }
  }
  if (traceId) {
    notes.push(
      `eval trace ${traceId}: to label rows, read their item ids with lbb_evals action=trace trace_id=${traceId}, then call lbb_evals action=label trace_id=${traceId} item=<id> valid=true|false (or items=[…]).`,
    );
  }
  notes.push(...historyNotes(response.history));
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
