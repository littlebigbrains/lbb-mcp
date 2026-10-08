import type { LbbClient } from "@littlebigbrain/client";
import { lexicalRow, listLimit, type Term } from "./query-tools.js";
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

// The request and response of `POST /v1/query/ask`, as this tool sends and
// reads them. They are local types, so the package builds against a client
// release whose generated schema does not name the route yet.

type QuestionRoute =
  "lookup" | "aggregate" | "search" | "history" | "schema" | "unanswerable";

type Entailment = "none" | "subclass" | "rdfs" | "owl";

interface QuestionRequest {
  question: string;
  context?: string;
  route?: QuestionRoute;
  limit?: number;
  anchor?: string[];
  timeline?: TimelinePoint[];
}

/** One tool call of the server's answer loop. */
interface AnswerStep {
  n: number;
  tool: string;
  input?: unknown;
  ok: boolean;
  rows?: number | null;
  error?: string | null;
  ms?: number;
}

/** A date and the commit that holds the graph as it was then. */
interface TimelinePoint {
  date: string;
  as_of_commit_seq: number;
  label?: string;
}

type QuestionTerm = Term;

/** One entity whose rows differ between the two points of a comparison. */
interface QuestionChange {
  key: Record<string, QuestionTerm>;
  before: Record<string, QuestionTerm>[];
  after: Record<string, QuestionTerm>[];
}

/** The size of each list of a comparison. */
interface QuestionTotals {
  added: number;
  removed: number;
  changed: number;
  unchanged?: number;
}

/** Where a history question read the graph, and what a comparison found. */
interface QuestionHistory {
  as_of_date?: string | null;
  compare: boolean;
  as_of_commit_seq?: number | null;
  resolved_by?: "commit_time" | "timeline" | "request" | null;
  label?: string | null;
  key?: string[];
  added?: Record<string, QuestionTerm>[] | null;
  removed?: Record<string, QuestionTerm>[] | null;
  changed?: QuestionChange[] | null;
  totals?: QuestionTotals | null;
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

/**
 * How to draw the rows of the answer's query, as the server checked it:
 * the columns exist in the rows, and `y` holds numbers for `bar` and `line`
 * (`x` and `y` for `scatter`).
 */
interface QuestionChart {
  kind: "bar" | "line" | "scatter" | "table";
  x?: string | null;
  y?: string | null;
  series?: string | null;
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
  answer?: {
    text: string;
    citations?: string[];
    chart?: QuestionChart | null;
  } | null;
  steps?: AnswerStep[];
}

export interface QuestionArgs {
  question: string;
  context?: string;
  route?: QuestionRoute;
  limit?: number;
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

/** One event of a streamed question, as this tool reads it. */
type StreamEvent = { event: string; data: unknown };

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
    case "step": {
      // A compare step counts the entries that differ, not rows.
      const unit = data.tool === "compare" ? "difference" : "row";
      const rows =
        typeof data.rows === "number"
          ? `: ${data.rows} ${unit}${data.rows === 1 ? "" : "s"}`
          : "";
      const outcome = data.ok === false ? ": failed" : rows;
      return `Step ${String(data.n)}, ${String(data.tool)} ${String(data.input ?? "")}${outcome}`;
    }
    case "answer":
      return "Answered";
    default:
      return undefined;
  }
}

type AskStream = (
  question: string,
  options: Omit<QuestionRequest, "question"> & { signal?: AbortSignal },
) => AsyncIterable<StreamEvent>;

/**
 * The question as a stream of progress events. Each event becomes one
 * progress notification; the `done` event is the same response as the call
 * without a stream. A client release without `query.askStream` answers
 * without progress.
 */
async function streamedAnswer(
  target: LbbClient,
  body: QuestionRequest,
  progress: QuestionProgress,
): Promise<QuestionResponse | undefined> {
  const query = target.query as unknown as { askStream?: AskStream };
  if (typeof query.askStream !== "function") return undefined;
  const { question, ...options } = body;
  let step = 0;
  for await (const event of query.askStream.call(target.query, question, {
    ...options,
    signal: progress.signal,
  })) {
    if (event.event === "done") return event.data as QuestionResponse;
    const message = progressMessage(event);
    if (message === undefined) continue;
    step += 1;
    // A lost notification never fails the question.
    await progress.report(step, message).catch(() => undefined);
  }
  throw new Error("the answer stream ended before its done event");
}

/** The totals of a comparison: the server's, else the lengths of its lists. */
function historyTotals(history: QuestionHistory): QuestionTotals {
  return (
    history.totals ?? {
      added: history.added?.length ?? 0,
      removed: history.removed?.length ?? 0,
      changed: history.changed?.length ?? 0,
    }
  );
}

/**
 * The history the tool returns: where the question read the graph, and for
 * a comparison the rows that differ as lexical values, with the total of
 * each list. Each list shows at most `limit` entries; `shown` says how many
 * when a list is cut.
 */
function historyView(
  history: QuestionHistory,
  limit: number,
): Record<string, unknown> {
  const view: Record<string, unknown> = { ...history };
  if (!history.added && !history.removed && !history.changed) return view;
  const totals = historyTotals(history);
  view.totals = totals;
  const shown: Record<string, number> = {};
  const show = <T, U>(
    name: keyof QuestionTotals,
    list: T[] | null | undefined,
    map: (item: T) => U,
  ) => {
    if (!list) return;
    const kept = list.slice(0, limit);
    view[name] = kept.map(map);
    if (kept.length < (totals[name] ?? list.length)) shown[name] = kept.length;
  };
  show("added", history.added, lexicalRow);
  show("removed", history.removed, lexicalRow);
  show("changed", history.changed, (change) => ({
    key: lexicalRow(change.key),
    before: change.before.map(lexicalRow),
    after: change.after.map(lexicalRow),
  }));
  if (Object.keys(shown).length) view.shown = shown;
  return view;
}

/** What the agent should know about the history of the answer. */
function historyNotes(
  history: QuestionHistory | null | undefined,
  limit: number,
  query:
    { sparql: string; as_of_commit_seq?: number | null } | null | undefined,
): string[] {
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
  if (history.compare && (history.added || history.changed) && point) {
    const totals = historyTotals(history);
    // The compared query reads the later point.
    const later =
      typeof query?.as_of_commit_seq === "number"
        ? query.as_of_commit_seq
        : undefined;
    const keyed = history.key?.length
      ? `paired by ${history.key.map((v) => `?${v}`).join(", ")}: history.added and history.removed hold the entities at one point only, history.changed the entities whose values differ`
      : "history.added and history.removed hold the rows that differ (a changed value is a removed row and an added row)";
    notes.push(
      `A comparison from ${point} to ${later === undefined ? "the latest commit" : `commit ${later}`}; ${keyed}. Totals: added ${totals.added}, removed ${totals.removed}, changed ${totals.changed}.`,
    );
    const cut = (["added", "removed", "changed"] as const).filter(
      (name) => totals[name] > limit,
    );
    if (cut.length && query) {
      const after =
        later === undefined ? "" : ` after={"as_of_commit_seq": ${later}}`;
      const key = history.key?.length
        ? ` key=${JSON.stringify(history.key)}`
        : "";
      notes.push(
        `Each list shows at most ${limit} entries (${cut.map((name) => `${name}: ${totals[name]}`).join(", ")}; see history.shown). Read them all, page by page, with lbb_query mode=compare query=<the query> before={"as_of_commit_seq": ${history.as_of_commit_seq}}${after}${key}.`,
      );
    }
    if (history.truncated) {
      notes.push(
        "The difference is not complete: a point was not read whole, or a list held more than 500 entries on the server. Use lbb_query mode=compare for the whole difference.",
      );
    }
  }
  return notes;
}

/**
 * `lbb_query mode=question`: the server answers the question in plain words
 * (`POST /v1/query/ask`). Its model runs queries in a bounded loop and
 * reads their rows. The result holds the answer, its citations and chart
 * hint, the steps, and the rows of the query the answer stands on, bounded
 * as `mode=sparql`
 * bounds them; `next` continues that query with `mode=sparql`. With
 * `progress`, the server streams its steps and each step is reported; the
 * result is the same.
 */
export async function answerQuestion(
  client: LbbClient,
  args: QuestionArgs,
  textFormat?: "compact" | "pretty",
  progress?: QuestionProgress,
) {
  const detail = normalizeDetail(args.detail);
  const rowLimit = Math.min(
    args.limit ?? defaultRowLimit(detail),
    QUESTION_MAX_ROWS,
  );
  const target = scoped(client, args.graph);
  const body: QuestionRequest = {
    question: args.question,
    ...(args.context !== undefined ? { context: args.context } : {}),
    ...(args.route !== undefined ? { route: args.route } : {}),
    limit: rowLimit,
    ...(args.anchor?.length ? { anchor: args.anchor } : {}),
    ...(args.timeline?.length ? { timeline: args.timeline } : {}),
  };
  // Each call uses model tokens, so a failed call is not retried.
  const response =
    (progress ? await streamedAnswer(target, body, progress) : undefined) ??
    (await target.request<QuestionResponse>("POST", "/v1/query/ask", {
      body,
      retry: false,
      query: { consistency: target.defaultConsistency },
    }));

  const { route, query, result } = response;
  const traceId = result?.trace_id ?? null;
  const answer: Record<string, unknown> = {
    answer: response.answer
      ? {
          text: response.answer.text,
          citations: response.answer.citations ?? [],
          ...(response.answer.chart ? { chart: response.answer.chart } : {}),
        }
      : null,
    steps: (response.steps ?? []).map((step) => ({
      n: step.n,
      tool: step.tool,
      ok: step.ok,
      ...(typeof step.rows === "number" ? { rows: step.rows } : {}),
      ...(step.error ? { error: step.error } : {}),
    })),
    route: { kind: route.kind, confidence: route.confidence, by: route.by },
    rationale: response.rationale,
    sparql: query?.sparql ?? null,
    entailment: query?.entailment ?? null,
    ...(typeof query?.as_of_commit_seq === "number"
      ? { as_of_commit_seq: query.as_of_commit_seq }
      : {}),
    ...(response.history
      ? { history: historyView(response.history, listLimit(detail)) }
      : {}),
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
  notes.push(...historyNotes(response.history, listLimit(detail), query));
  if (!response.answer) {
    notes.push(
      "The answer loop stopped before it answered (see error); the rows are the best ones it read. Continue with lbb_query mode=sparql, or ask again with more context.",
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
  // No rows to page: an ASK answer, a comparison, or no query at all. The
  // query text is returned whole.
  const summary = data
    ? `${label}: ran the query`
    : response.history?.compare
      ? `${label}: compared two points`
      : query
        ? `${label}: no rows`
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
