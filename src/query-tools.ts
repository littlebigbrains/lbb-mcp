import type { LbbClient } from "@littlebigbrain/client";
import { HARD_OUTPUT_CHARS, type Detail } from "./tool-contracts.js";
import {
  compactLimits,
  normalizeDetail,
  scoped,
  toolResult,
  truncateValue,
} from "./tool-runtime.js";

// The tools for agents of the query rewriter: `POST /v1/query/names`,
// `POST /v1/query/describe`, `GET /v1/graph/commit-at` and
// `POST /v1/query/compare`. The shapes are local types, so the package
// builds against a client release whose generated schema does not name the
// routes yet.

/** One value of a row, as SPARQL 1.1 Query Results JSON writes it. */
export interface Term {
  type: string;
  value: string;
  datatype?: string | null;
  "xml:lang"?: string | null;
}

/** A row as `{ variable: lexical value }`. */
export function lexicalRow(row: Record<string, Term>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([name, term]) => [name, term.value]),
  );
}

/** Entries of each list a page shows, by detail. */
export function listLimit(detail: Detail): number {
  switch (detail) {
    case "full":
      return 500;
    case "standard":
      return 100;
    default:
      return 20;
  }
}

/** Long strings cut by detail; every entry stays, so no cursor skips one. */
function boundStrings(value: unknown, detail: Detail): unknown {
  return truncateValue(
    value,
    {
      maxItems: Number.MAX_SAFE_INTEGER,
      maxString: compactLimits(detail).maxString,
    },
    { truncated: false },
  );
}

/** A tool result that must fit the MCP output budget whole. */
function fitted(value: Record<string, unknown>, narrow: string) {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") > HARD_OUTPUT_CHARS) {
    throw new Error(`The answer exceeds the MCP output budget. ${narrow}`);
  }
  return toolResult(value);
}

// ---- names ----------------------------------------------------------------------

interface NameCandidate {
  text: string;
  iri: string;
  label?: string | null;
  class: string;
  score: number;
  by: string;
}

interface NamesResponse {
  candidates: NameCandidate[];
  index_ready: boolean;
  index_names?: number | null;
  commit_seq: number;
  ms: number;
}

export interface NamesArgs {
  text: string;
  limit?: number;
  detail?: string;
  graph?: string;
}

/** `lbb_query mode=names`: the entities the text names, per name. */
export async function findNames(client: LbbClient, args: NamesArgs) {
  const target = scoped(client, args.graph);
  const response = await target.request<NamesResponse>(
    "POST",
    "/v1/query/names",
    {
      body: {
        text: args.text,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      retry: true,
    },
  );
  const names: Array<{
    text: string;
    candidates: Omit<NameCandidate, "text">[];
  }> = [];
  for (const { text, ...candidate } of response.candidates) {
    const last = names[names.length - 1];
    if (last && last.text === text) last.candidates.push(candidate);
    else names.push({ text, candidates: [candidate] });
  }
  const notes: string[] = [];
  if (!response.index_ready) {
    notes.push(
      "The graph's name index is still building: ask again in a few seconds.",
    );
  } else if (names.length === 0) {
    notes.push(
      'No name of the text matched an entity. Match the name in SPARQL instead, without case and on a short distinctive part, for example FILTER(CONTAINS(LCASE(STR(?label)), "quellm")).',
    );
  } else {
    notes.push(
      "Use the first candidate of each name unless its class does not fit the question; put its IRI in the query (as a subject, an object or in VALUES) instead of matching the name.",
    );
  }
  const count = response.candidates.length;
  return fitted(
    {
      summary: `lbb_query.names: ${names.length} ${names.length === 1 ? "name" : "names"}, ${count} ${count === 1 ? "candidate" : "candidates"}`,
      data: {
        names,
        index_ready: response.index_ready,
        commit_seq: response.commit_seq,
      },
      notes,
    },
    "Pass a shorter text.",
  );
}

// ---- describe -------------------------------------------------------------------

interface DescribeResponse {
  commit_seq: number;
  partial: boolean;
  classes: unknown[];
  properties: unknown[];
  statements: unknown[];
  unknown?: string[];
  prefixes: Record<string, string>;
  text: string;
  age_ms: number;
}

export interface DescribeArgs {
  question?: string;
  classes?: string[];
  properties?: string[];
  detail?: string;
  graph?: string;
}

/**
 * `lbb_query mode=describe`: the parts of the graph a question needs. The
 * compact and standard answers are the server's text; full adds the same
 * description as JSON.
 */
export async function describeGraph(client: LbbClient, args: DescribeArgs) {
  const detail = normalizeDetail(args.detail);
  const target = scoped(client, args.graph);
  const response = await target.request<DescribeResponse>(
    "POST",
    "/v1/query/describe",
    {
      body: {
        ...(args.question !== undefined ? { question: args.question } : {}),
        ...(args.classes?.length ? { classes: args.classes } : {}),
        ...(args.properties?.length ? { properties: args.properties } : {}),
      },
      retry: true,
    },
  );
  const notes: string[] = [];
  if (response.partial) {
    notes.push(
      "The server is still sampling the graph: coverage and the values of small classes can be missing. Ask again in a minute for the whole description.",
    );
  }
  if (response.unknown?.length) {
    notes.push(
      `The graph has no class or property ${response.unknown.join(", ")}.`,
    );
  }
  notes.push(
    "A property that few sampled instances hold (n of m) is rare: a filter on it returns few rows. Use the listed values of small classes as they are written.",
  );
  const data: Record<string, unknown> = {
    commit_seq: response.commit_seq,
    partial: response.partial,
    text: response.text,
    ...(response.unknown?.length ? { unknown: response.unknown } : {}),
  };
  if (detail === "full") {
    data.classes = response.classes;
    data.properties = response.properties;
    data.statements = response.statements;
    data.prefixes = response.prefixes;
  }
  return fitted(
    {
      summary: `lbb_query.describe: ${response.classes.length} classes, ${response.properties.length} properties`,
      data,
      notes,
    },
    "Name fewer classes, or use detail=standard.",
  );
}

// ---- commit at ------------------------------------------------------------------

interface CommitAtResponse {
  moment: string;
  as_of_commit_seq?: number | null;
  committed_at?: string | null;
  resolved_by?: "commit_time" | "head_write" | null;
  first_commit_at?: string | null;
  note?: string | null;
}

export interface CommitAtArgs {
  date?: string;
  moment?: string;
  graph?: string;
}

/** `lbb_query mode=commit_at`: the commit of a date or a moment. */
export async function commitAt(client: LbbClient, args: CommitAtArgs) {
  if ((args.date === undefined) === (args.moment === undefined)) {
    throw new Error("commit_at needs exactly one of date and moment");
  }
  const target = scoped(client, args.graph);
  const response = await target.request<CommitAtResponse>(
    "GET",
    "/v1/graph/commit-at",
    {
      query: { date: args.date, moment: args.moment },
      retry: true,
    },
  );
  const notes: string[] = [];
  if (typeof response.as_of_commit_seq === "number") {
    notes.push(
      `Read the graph as it was then with lbb_query mode=sparql as_of_commit_seq=${response.as_of_commit_seq}, or compare two points with lbb_query mode=compare.`,
    );
  }
  if (response.note) notes.push(response.note);
  return toolResult({
    summary:
      typeof response.as_of_commit_seq === "number"
        ? `lbb_query.commit_at: commit ${response.as_of_commit_seq}`
        : "lbb_query.commit_at: no commit",
    data: response,
    notes,
  });
}

// ---- compare --------------------------------------------------------------------

interface ComparePoint {
  as_of_commit_seq?: number;
  date?: string;
  moment?: string;
}

interface CompareChange {
  key: Record<string, Term>;
  before: Record<string, Term>[];
  after: Record<string, Term>[];
}

interface CompareTotals {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

interface CompareResponse {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  vars: string[];
  key?: string[];
  added: Record<string, Term>[];
  removed: Record<string, Term>[];
  changed: CompareChange[];
  totals: CompareTotals;
  offset: number;
  next_cursor?: string | null;
  truncated?: boolean;
  notes?: string[];
  ms: number;
}

export interface CompareArgs {
  query: string;
  before: ComparePoint;
  after?: ComparePoint;
  key?: string[];
  entailment?: "none" | "subclass" | "rdfs" | "owl";
  max_rows?: number;
  limit?: number;
  compare_cursor?: string;
  detail?: string;
  graph?: string;
}

/**
 * `lbb_query mode=compare`: one SELECT at two points, the rows paired by
 * `key`. Each list shows one page with its total; `next` continues with the
 * server's cursor.
 */
export async function compareQuery(client: LbbClient, args: CompareArgs) {
  const detail = normalizeDetail(args.detail);
  const target = scoped(client, args.graph);
  const limit = args.limit ?? listLimit(detail);
  const response = await target.request<CompareResponse>(
    "POST",
    "/v1/query/compare",
    {
      body: {
        query: args.query,
        before: args.before,
        ...(args.after ? { after: args.after } : {}),
        ...(args.key?.length ? { key: args.key } : {}),
        ...(args.entailment ? { entailment: args.entailment } : {}),
        ...(args.max_rows !== undefined ? { max_rows: args.max_rows } : {}),
        limit,
        ...(args.compare_cursor ? { cursor: args.compare_cursor } : {}),
      },
      retry: true,
      query: { consistency: target.defaultConsistency },
    },
  );
  const notes = [...(response.notes ?? [])];
  const totals = response.totals;
  const shown = {
    added: response.added.length,
    removed: response.removed.length,
    changed: response.changed.length,
  };
  const cut = (Object.keys(shown) as Array<keyof typeof shown>).filter(
    (name) => response.offset + shown[name] < totals[name],
  );
  if (cut.length) {
    notes.push(
      `This page shows entries ${response.offset + 1} to ${response.offset + limit} of each list (${cut.map((name) => `${name}: ${totals[name]}`).join(", ")}). Call again with the arguments in next for the next page.`,
    );
  }
  const data = boundStrings(
    {
      before: response.before,
      after: response.after,
      key: response.key ?? [],
      totals,
      added: response.added.map(lexicalRow),
      removed: response.removed.map(lexicalRow),
      changed: response.changed.map((change) => ({
        key: lexicalRow(change.key),
        before: change.before.map(lexicalRow),
        after: change.after.map(lexicalRow),
      })),
      offset: response.offset,
      ...(response.truncated ? { truncated: true } : {}),
    },
    detail,
  );
  const next = response.next_cursor
    ? {
        mode: "compare",
        query: args.query,
        before: args.before,
        ...(args.after ? { after: args.after } : {}),
        ...(args.key?.length ? { key: args.key } : {}),
        ...(args.entailment ? { entailment: args.entailment } : {}),
        ...(args.max_rows !== undefined ? { max_rows: args.max_rows } : {}),
        limit,
        compare_cursor: response.next_cursor,
        ...(args.detail ? { detail: args.detail } : {}),
        ...(args.graph ? { graph: args.graph } : {}),
      }
    : undefined;
  return fitted(
    {
      summary: `lbb_query.compare: added ${totals.added}, removed ${totals.removed}, changed ${totals.changed}${response.truncated ? " [not complete: a point was not read whole]" : ""}`,
      data,
      ...(next ? { next } : {}),
      notes,
    },
    "Pass a smaller limit, or project fewer variables.",
  );
}
