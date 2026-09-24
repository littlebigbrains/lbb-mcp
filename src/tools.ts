import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LbbClient } from "@littlebigbrain/client";
import { z } from "zod";
import { metadataPage } from "./metadata-pages.js";
import { registerRdfTool } from "./rdf-tool.js";
import { queryTiming, type LbbServerOptions } from "./query-observer.js";
import {
  DESTRUCTIVE,
  IDEMPOTENT_WRITE,
  MUTATING,
  READ_ONLY,
  configureInputSchema,
  configureWireSchema,
  detailSchema,
  graphScope,
  inspectInputSchema,
  inspectWireSchema,
  jsonObjectSchema,
  queryInputSchema,
  queryWireSchema,
  searchFeedbackSchema,
  type QueryCursor,
} from "./tool-contracts.js";
import {
  analyze,
  assertCursorScope,
  contentHashKey,
  decodeQueryCursor,
  effectiveRowLimit,
  enrichError,
  errorResult,
  guide,
  normalizeDetail,
  normalizeLbbIris,
  ontologyDefineBody,
  queryCommitPin,
  queryEnvelope,
  queryToolResult,
  requireString,
  rowPageFrom,
  rowPageNext,
  run,
  scoped,
  stableJson,
  toolResult,
} from "./tool-runtime.js";

export function registerLbbTools(
  server: McpServer,
  client: LbbClient,
  options: LbbServerOptions = {},
): void {
  registerRdfTool(server, client);
  server.registerTool(
    "lbb_inspect",
    {
      description:
        "Read graph context and exact graph facts. Actions: guide, graphs, publication, ontology, ontology_conformance, schema, ontology_search, metadata, entity, state, history, transitions, why. graphs works before bootstrap; publication reports whether writes are queryable. ontology and schema return complete entries with page_size, section and cursor; follow next until absent. schema reads active native ontology/SHACL metadata without running validation. Query asserted RDF/OWL axioms separately with lbb_query. ontology_conformance serves the durable report referenced by the pinned published root. entity returns one node's metadata, scalar attributes, bounded Base-backed edge neighborhood, history, and observations. Use lbb_query with SPARQL property paths for precise path selection.",
      inputSchema: inspectWireSchema,
      annotations: READ_ONLY,
    },
    (rawArgs) => {
      const parsed = inspectInputSchema.safeParse(rawArgs);
      if (!parsed.success) return errorResult(parsed.error);
      const args = parsed.data;
      if (args.action === "ontology" || args.action === "schema") {
        return metadataPage(client, args)
          .then(toolResult)
          .catch(async (error) =>
            errorResult(await enrichError(client, error)),
          );
      }
      return run(client, `lbb_inspect.${args.action}`, args.detail, () => {
        const target = scoped(client, args.graph, args.branch);
        switch (args.action) {
          case "guide":
            return guide(target);
          case "graphs":
            return target.listGraphs();
          case "publication":
            return target.publicationStatus();
          case "ontology_conformance":
            return target.ontologyConformance();
          case "ontology_search":
            return target.ontologySearch({
              query: args.query,
              search: { concepts: true, terms: true, relations: true },
              top_k: args.top_k ?? 10,
              explain: false,
            } as never);
          case "metadata":
            return target.metadata();
          case "entity":
            return target.entityDetail({
              ...(args.entity_id
                ? { id: args.entity_id }
                : {
                    type: requireString(args.entity_type, "entity_type"),
                    name: requireString(args.name, "name"),
                  }),
              asOf: args.as_of,
              asOfCommitSeq: args.as_of_commit_seq,
            });
          case "state":
            return target.currentState({
              entity: {
                entity_type: args.entity_type,
                name: args.name,
              },
              relations: args.relation ? [args.relation] : null,
              as_of_valid_time: args.as_of ?? null,
              as_of_commit_seq: args.as_of_commit_seq ?? null,
            } as never);
          case "history":
            return target.history({
              source: {
                entity_type: args.entity_type,
                name: args.name,
              },
              relation: args.relation ?? null,
            } as never);
          case "why":
            return target.why({
              source: {
                entity_type: args.source_type,
                name: args.source_name,
              },
              relation: args.relation,
              target: {
                entity_type: args.target_type,
                name: args.target_name,
              },
            } as never);
          case "transitions":
            return target.transitions({
              entity: {
                entity_type: args.entity_type,
                name: args.name,
              },
              relation: args.relation,
              as_of_valid_time: args.as_of ?? null,
              as_of_commit_seq: args.as_of_commit_seq ?? null,
            } as never);
        }
      });
    },
  );

  server.registerTool(
    "lbb_query",
    {
      description:
        "Analytical and expert reads. Modes: structured (SPARQL-subset JSON body), sparql (SPARQL text), search (instances by meaning over every searchable class; filter narrows by class and relationship; every hit checked against the graph), analyze. SPARQL is the query language; search finds what the words describe. To plan a search: lbb_embeddings action=list, then SPARQL for a class's relationships on a sample, then mode=search with explain=true to check the resolved filter before the real search (lbb_inspect action=guide has the queries). Relations are <https://littlebigbrain.com/r/NAME> and types <https://littlebigbrain.com/class/NAME> (both lowercased); entities are content-addressed, so anchor a named one by its rdfs:label rather than building its IRI. Structured and text queries pin one published watermark for the request.",
      inputSchema: queryWireSchema,
      annotations: READ_ONLY,
    },
    (rawArgs) => {
      const parsed = queryInputSchema.safeParse(rawArgs);
      if (!parsed.success) return errorResult(parsed.error);
      const args = parsed.data;
      if (args.mode === "structured" || args.mode === "sparql") {
        return (async () => {
          try {
            const cursor = decodeQueryCursor(args.cursor);
            if (cursor && cursor.mode !== args.mode) {
              throw new Error(`cursor is for ${cursor.mode}, not ${args.mode}`);
            }
            assertCursorScope(
              { graph: args.graph, branch: args.branch },
              cursor,
            );
            if (
              cursor &&
              args.row_limit !== undefined &&
              args.row_limit !== cursor.row_limit
            ) {
              throw new Error(
                "cursor row_limit does not match the supplied row_limit argument",
              );
            }
            const detail = normalizeDetail(args.detail ?? cursor?.detail);
            const rowLimit = effectiveRowLimit(
              detail,
              args.row_limit ?? cursor?.row_limit,
            );
            const graph = cursor?.graph ?? args.graph;
            const branch = cursor?.branch ?? args.branch;
            const offset = cursor?.offset ?? 0;
            const target = scoped(client, graph, branch);
            const timing = queryTiming(options, {
              mode: args.mode,
              continuation: cursor !== undefined,
              row_limit: rowLimit,
              offset,
            });
            const pin = (requested?: number) =>
              !cursor && requested === undefined
                ? timing.measureAsync("query_pin_metadata", () =>
                    queryCommitPin(target, requested, cursor),
                  )
                : queryCommitPin(target, requested, cursor);
            const buildEnvelope = (
              value: unknown,
              rowPage: ReturnType<typeof rowPageFrom>,
              next: Record<string, unknown> | undefined,
              cursorBase: Omit<QueryCursor, "offset">,
              notes?: string[],
            ) =>
              timing.measure("query_envelope", () => {
                timing.counts({ received_rows: rowPage?.returned });
                const result = queryEnvelope(
                  `lbb_query.${args.mode}`,
                  value,
                  detail,
                  rowPage,
                  next,
                  cursorBase,
                  { textFormat: options.queryTextFormat, notes },
                );
                if (options.timing) {
                  const nextCursor = (
                    result.next as { cursor?: unknown } | undefined
                  )?.cursor;
                  timing.counts({
                    returned_rows: rowPageFrom(result)?.returned,
                    cursor_bytes:
                      typeof nextCursor === "string"
                        ? Buffer.byteLength(nextCursor, "utf8")
                        : 0,
                  });
                }
                return result;
              });
            const render = (value: Record<string, unknown>) =>
              timing.measure("query_render", () => {
                const result = queryToolResult(value, options.queryTextFormat);
                if (options.timing)
                  timing.counts({
                    text_bytes: Buffer.byteLength(
                      result.content[0].text,
                      "utf8",
                    ),
                  });
                return result;
              });
            for (const key of [
              "entailment",
              "consistency",
              "min_indexed_seq",
            ] as const) {
              if (
                cursor &&
                args[key] !== undefined &&
                args[key] !== cursor[key]
              ) {
                throw new Error(
                  `cursor ${key} does not match the supplied ${key}`,
                );
              }
            }
            const consistency = cursor?.consistency ?? args.consistency;
            const minIndexedSeq =
              cursor?.min_indexed_seq ?? args.min_indexed_seq;

            if (args.mode === "structured") {
              const body = (cursor?.body ?? args.body) as
                Record<string, unknown> | undefined;
              if (body === undefined)
                throw new Error("body is required unless cursor is supplied");
              if (
                cursor &&
                args.body !== undefined &&
                stableJson(args.body) !== stableJson(cursor.body)
              ) {
                throw new Error(
                  "cursor body does not match the supplied body argument",
                );
              }
              if (
                args.as_of !== undefined ||
                cursor?.as_of !== undefined ||
                body.as_of !== undefined ||
                body.as_of_valid_time !== undefined
              ) {
                throw new Error(
                  "structured SPARQL valid-time selectors are not supported; use as_of_commit_seq for a retained commit snapshot, or start a new query without the valid-time selector",
                );
              }
              for (const key of ["consistency", "min_indexed_seq"] as const) {
                const requested =
                  key === "consistency" ? consistency : minIndexedSeq;
                if (
                  requested !== undefined &&
                  body[key] !== undefined &&
                  requested !== body[key]
                )
                  throw new Error(
                    `body ${key} conflicts with the query's ${key}`,
                  );
              }
              // Resolve the top-level or body commit pin once and retain it
              // across cursor pages. The API validates its exact RDF lineage.
              if (
                body.as_of_commit_seq !== undefined &&
                body.as_of_commit_seq !== null &&
                (typeof body.as_of_commit_seq !== "number" ||
                  !Number.isSafeInteger(body.as_of_commit_seq) ||
                  body.as_of_commit_seq < 0)
              ) {
                throw new Error(
                  "body as_of_commit_seq must be a nonnegative safe integer",
                );
              }
              const requestedCommitSeq =
                args.as_of_commit_seq ??
                (typeof body.as_of_commit_seq === "number"
                  ? body.as_of_commit_seq
                  : undefined);
              if (
                cursor &&
                args.as_of_commit_seq !== undefined &&
                args.as_of_commit_seq !== cursor.as_of_commit_seq
              ) {
                throw new Error(
                  "cursor as_of_commit_seq does not match the supplied as_of_commit_seq argument",
                );
              }
              const asOfCommitSeq = await pin(requestedCommitSeq);
              const request: Record<string, unknown> = {
                ...body,
                limit: rowLimit,
                offset,
                as_of_commit_seq: asOfCommitSeq,
              };
              // The analytics route is gone; structured bodies run only on the
              // SPARQL-select path, which rejects unknown fields. Name the
              // removal here so a `combinators` body fails with an actionable
              // message instead of an opaque schema rejection.
              if (
                Array.isArray(request.combinators) &&
                request.combinators.length > 0
              ) {
                throw new Error(
                  "`combinators` (UNION/OPTIONAL/MINUS/EXISTS) is no longer accepted by structured mode; the analytics route was removed. Express the same query as SPARQL text with mode=sparql.",
                );
              }
              const response = await timing.measureAsync(
                "query_http_total",
                () =>
                  target.sparql(request as never, {
                    consistency,
                    minIndexedSeq,
                  }),
              );
              const rowPage = rowPageFrom(response);
              const cursorBase: Omit<QueryCursor, "offset"> = {
                v: 1,
                mode: "structured",
                graph,
                branch,
                detail,
                row_limit: rowLimit,
                body,
                consistency,
                min_indexed_seq: minIndexedSeq,
                as_of_commit_seq: asOfCommitSeq,
              };
              const next = rowPageNext(cursorBase, rowPage);
              return render(buildEnvelope(response, rowPage, next, cursorBase));
            }

            // Canonicalize little big brain relation/class/property IRI local-name case up
            // front, then use the normalized text everywhere (mismatch check,
            // request, cursor) so a continuation page that re-passes the raw
            // query still matches the already-normalized cursor query. A cursor's
            // stored query is already normalized, so paging never repeats the note.
            const rawQuery =
              cursor?.query ?? requireString(args.query, "query");
            const { query, notes } = normalizeLbbIris(rawQuery);
            if (
              cursor &&
              args.query !== undefined &&
              normalizeLbbIris(args.query).query !== cursor.query
            ) {
              throw new Error(
                "cursor query does not match the supplied query argument",
              );
            }
            if (args.as_of !== undefined || cursor?.as_of !== undefined) {
              throw new Error(
                "SPARQL text valid-time as_of is not supported; use as_of_commit_seq for a retained commit snapshot, or start a new query without as_of",
              );
            }
            if (
              cursor &&
              args.as_of_commit_seq !== undefined &&
              args.as_of_commit_seq !== cursor.as_of_commit_seq
            ) {
              throw new Error(
                "cursor as_of_commit_seq does not match the supplied as_of_commit_seq argument",
              );
            }
            const asOfCommitSeq = await pin(args.as_of_commit_seq);
            const entailment = cursor?.entailment ?? args.entailment ?? "none";
            const response = await timing.measureAsync("query_http_total", () =>
              target.sparqlText(
                {
                  query,
                  entailment,
                  as_of_commit_seq: asOfCommitSeq ?? null,
                  limit: rowLimit,
                  offset,
                  // Managed evals: the first page records a trace; a
                  // continuation page re-reads the same rows and must not.
                  ...(cursor === undefined && args.request
                    ? { request: args.request }
                    : {}),
                },
                { consistency, minIndexedSeq },
              ),
            );
            if (response.trace_id) {
              notes.push(
                `eval trace ${response.trace_id}: to label rows, read their item ids with lbb_evals action=trace trace_id=${response.trace_id}, then call lbb_evals action=label trace_id=${response.trace_id} item=<id> valid=true|false (or items=[…]).`,
              );
            }
            const data = timing.measure("query_results_parse", () =>
              JSON.parse(response.results),
            );
            const rowPage = rowPageFrom(response);
            const cursorBase: Omit<QueryCursor, "offset"> = {
              v: 1,
              mode: "sparql",
              graph,
              branch,
              detail,
              row_limit: rowLimit,
              query,
              entailment,
              consistency,
              min_indexed_seq: minIndexedSeq,
              as_of_commit_seq: asOfCommitSeq,
            };
            const next = rowPageNext(cursorBase, rowPage);
            const sparqlEnvelope = buildEnvelope(
              data,
              rowPage,
              next,
              cursorBase,
              notes,
            );
            return render(sparqlEnvelope);
          } catch (error) {
            return errorResult(await enrichError(client, error));
          }
        })();
      }
      if (args.mode === "search") {
        const searchArgs = args;
        return run(client, "lbb_query.search", undefined, async () => {
          const target = scoped(client, searchArgs.graph, searchArgs.branch);
          return target.embeddings.search({
            embedding: searchArgs.embedding,
            text: searchArgs.text,
            top_k: searchArgs.top_k,
            probe: searchArgs.probe,
            include: searchArgs.include,
            request: searchArgs.request,
            filter: searchArgs.filter,
            explain: searchArgs.explain,
          });
        });
      }
      return run(client, `lbb_query.${args.mode}`, args.detail, async () => {
        const target = scoped(client, args.graph, args.branch);
        return analyze(target, {
          metric: args.metric,
          chart: args.chart,
          top_k: args.top_k,
          query: args.query,
          field: args.field,
          sparql: args.sparql,
        });
      });
    },
  );

  server.registerTool(
    "lbb_models",
    {
      description:
        "Read model-training inputs or compare retrieval configurations over one pinned published snapshot. shadow_eval takes the API ShadowEvalRequest body; dataset actions return bounded training examples at an optional signal split.",
      inputSchema: {
        action: z.enum([
          "shadow_eval",
          "planner_dataset",
          "planner_preference_dataset",
          "suggest_dataset",
          "extractor_dataset",
        ]),
        body: jsonObjectSchema.optional(),
        limit: z.number().int().positive().optional(),
        split_seq: z.number().int().nonnegative().optional(),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    ({ action, body, limit, split_seq, detail, graph, branch }) =>
      run(client, `lbb_models.${action}`, detail, () => {
        const target = scoped(client, graph, branch);
        switch (action) {
          case "shadow_eval":
            if (!body) throw new Error("shadow_eval requires body");
            return target.shadowEval(body as never);
          case "planner_dataset":
            return target.plannerDataset({ limit, splitSeq: split_seq });
          case "planner_preference_dataset":
            return target.plannerPreferenceDataset({
              limit,
              splitSeq: split_seq,
            });
          case "suggest_dataset":
            return target.suggestDataset({ limit, splitSeq: split_seq });
          case "extractor_dataset":
            return target.extractorDataset({ limit, splitSeq: split_seq });
        }
      }),
  );

  const embeddingSetup = {
    class: z.string().optional().describe("preview/declare: the class IRI."),
    from: z
      .array(z.string())
      .optional()
      .describe(
        'preview/declare: the fields, e.g. ["label", "description", "calls/label"]. Omit for the automatic choice; on an existing embedding, omit to keep its fields.',
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe("preview/declare: fields to drop from the automatic choice."),
    model: z
      .string()
      .optional()
      .describe(
        "model: the graph's new model. preview/declare: omit it; a graph has one model (the graph's, or the platform's default for the first embedding).",
      ),
    dim: z.number().int().positive().optional(),
  };
  const recipeOf = (args: {
    class?: string;
    name?: string;
    from?: string[];
    exclude?: string[];
    model?: string;
    dim?: number;
  }) => {
    if (!args.class) throw new Error("this action requires class");
    return {
      class: args.class,
      ...(args.name ? { name: args.name } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.exclude ? { exclude: args.exclude } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.dim ? { dim: args.dim } : {}),
    };
  };

  server.registerTool(
    "lbb_embeddings",
    {
      description:
        "Search setup, read only: embeddings declared on classes (an embedding on a class covers its subclasses; one model per graph). list shows each embedding's status (serving and building version, backfill progress, lag) and the graph's model; get shows one; preview shows every candidate fact of a class with its coverage and examples, and the exact text of sample instances, and stores nothing. Declare, refresh, or change the model with lbb_embeddings_manage; search with lbb_query mode=search. list is the first step of planning a search (lbb_inspect action=guide has the recipe).",
      inputSchema: {
        action: z.enum(["list", "get", "preview"]),
        name: z.string().optional().describe("get: the embedding name."),
        ...embeddingSetup,
        sample: z.number().int().positive().max(50).optional(),
        iris: z
          .array(z.string())
          .optional()
          .describe("preview: the instances to show instead of a sample."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(client, `lbb_embeddings.${args.action}`, args.detail, () => {
        const target = scoped(client, args.graph, args.branch);
        switch (args.action) {
          case "list":
            return target.embeddings.list();
          case "get":
            if (!args.name) throw new Error("get requires name");
            return target.embeddings.get(args.name);
          case "preview":
            return target.embeddings.preview({
              ...recipeOf(args),
              ...(args.sample ? { sample: args.sample } : {}),
              ...(args.iris ? { iris: args.iris } : {}),
            } as never);
        }
      }),
  );

  server.registerTool(
    "lbb_embeddings_manage",
    {
      description:
        "Declare or refresh an embedding, or change the graph's model. Run lbb_embeddings action=preview first and show the user the text it will embed. declare sets the class, the fields (one-hop property paths such as label, description, calls/label; omit for an automatic choice); a new embedding takes the graph's model, and another model is refused. On an existing embedding it changes only what you name, and a changed recipe builds a new version while the old one serves. model moves every embedding of the graph to `model`: each builds a new version, and the graph switches when all are ready (a search never mixes two models). refresh runs one step of the embed job now (it also runs by itself after each published commit).",
      inputSchema: {
        action: z.enum(["declare", "refresh", "model"]),
        name: z
          .string()
          .optional()
          .describe("The embedding name (refresh: required)."),
        ...embeddingSetup,
        detail: detailSchema,
        ...graphScope,
      },
      annotations: MUTATING,
    },
    (args) =>
      run(client, `lbb_embeddings_manage.${args.action}`, args.detail, () => {
        const target = scoped(client, args.graph, args.branch);
        switch (args.action) {
          case "declare":
            return target.embeddings.declare(recipeOf(args) as never);
          case "refresh":
            if (!args.name) throw new Error("refresh requires name");
            return target.embeddings.refresh(args.name);
          case "model":
            if (!args.model) throw new Error("model requires model");
            return target.embeddings.setModel({
              model: args.model,
              ...(args.dim ? { dim: args.dim } : {}),
            });
        }
      }),
  );

  server.registerTool(
    "lbb_embeddings_delete",
    {
      description:
        "Delete an embedding: its name and its vectors (index-gc removes the stored runs). Its class stops being searchable until it is declared and built again. Ask the user first; confirm must repeat the name.",
      inputSchema: {
        name: z.string().describe("The embedding name."),
        confirm: z.string().describe("The same name again, to confirm."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: DESTRUCTIVE,
    },
    ({ name, confirm, detail, graph, branch }) =>
      run(client, "lbb_embeddings_delete", detail, () => {
        if (confirm !== name) {
          throw new Error("confirm must repeat the embedding name");
        }
        return scoped(client, graph, branch).embeddings.delete(name);
      }),
  );

  server.registerTool(
    "lbb_evals",
    {
      description:
        "Managed evals: the thumbs up / thumbs down of the graph, per result. A query run with `request` (lbb_query) records a trace with one item per result (hit or row); trace reads it back with the item ids. label marks one result (item + valid) or several (items) relevant or not; the labels become the golden's ground truth. golden freezes a query (every result it returns now is relevant). run replays every golden at the current commit: pass when every relevant result is back and no wrong one is; new results open a review trace. judge lets the platform's judge model (the hosted frontier model) label unlabeled results. summary, traces, goldens, results, and settings read state.",
      inputSchema: {
        action: z.enum([
          "summary",
          "traces",
          "trace",
          "label",
          "judge",
          "goldens",
          "golden",
          "accept",
          "delete",
          "run",
          "results",
          "settings",
        ]),
        trace_id: z
          .string()
          .optional()
          .describe("trace / label / judge: the trace id from lbb_query."),
        item: z
          .string()
          .optional()
          .describe(
            "label: the result id (a hit's `id`, or an item id from trace) to label with `valid`.",
          ),
        valid: z
          .boolean()
          .optional()
          .describe(
            "label: true = the result answers the request (thumbs up), false = it does not.",
          ),
        items: z
          .array(
            z
              .object({
                id: z.string(),
                valid: z.boolean(),
                note: z.string().optional(),
              })
              .strict(),
          )
          .optional()
          .describe("label: several results at once."),
        by: z
          .string()
          .optional()
          .describe("label: who labels (an agent name)."),
        note: z.string().optional(),
        sparql: z
          .string()
          .optional()
          .describe(
            "golden: the query to freeze (the search text for surface=search).",
          ),
        surface: z
          .enum(["sparql", "search"])
          .optional()
          .describe(
            "golden: which surface the query runs on (default sparql).",
          ),
        embedding: z
          .string()
          .optional()
          .describe("golden: the embedding, for surface=search."),
        top_k: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("golden: the top_k of a search golden."),
        request: z
          .string()
          .optional()
          .describe("golden: the user's words the query answers."),
        golden_id: z
          .string()
          .optional()
          .describe("accept / delete: the golden id."),
        limit: z.number().int().positive().optional(),
        unlabeled: z
          .boolean()
          .optional()
          .describe("traces: only traces without a label."),
        consistency: z
          .enum(["strong", "eventual"])
          .optional()
          .describe(
            "run / accept: strong reads the head, eventual the last published commit.",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: MUTATING,
    },
    ({
      action,
      trace_id,
      item,
      valid,
      items,
      by,
      note,
      sparql,
      surface,
      embedding,
      top_k,
      request,
      golden_id,
      limit,
      unlabeled,
      consistency,
      detail,
      graph,
      branch,
    }) =>
      run(client, `lbb_evals.${action}`, detail, () => {
        const target = scoped(client, graph, branch);
        switch (action) {
          case "summary":
            return target.evals.summary();
          case "traces":
            return target.evals.traces({ limit, unlabeled });
          case "trace":
            if (!trace_id) throw new Error("trace requires trace_id");
            return target.evals.trace(trace_id);
          case "label":
            if (!trace_id) throw new Error("label requires trace_id");
            if (!item && !items?.length)
              throw new Error("label requires item (with valid) or items");
            if (item && valid === undefined)
              throw new Error("label requires valid with item");
            return target.evals.label(trace_id, {
              ...(item ? { item, valid } : {}),
              ...(items?.length ? { items } : {}),
              by,
              note,
            });
          case "judge":
            return target.evals.judge({ traceId: trace_id, limit });
          case "goldens":
            return target.evals.goldens();
          case "golden":
            if (!sparql) throw new Error("golden requires sparql");
            if (surface === "search" && !embedding)
              throw new Error("a search golden requires embedding");
            return target.evals.createGolden({
              sparql,
              request,
              ...(surface ? { surface } : {}),
              ...(embedding ? { embedding } : {}),
              ...(top_k ? { top_k } : {}),
            });
          case "accept":
            if (!golden_id) throw new Error("accept requires golden_id");
            return target.evals.acceptGolden(golden_id, { consistency });
          case "delete":
            if (!golden_id) throw new Error("delete requires golden_id");
            return target.evals.deleteGolden(golden_id);
          case "run":
            return target.evals.run({ consistency });
          case "results":
            return target.evals.results({ limit });
          case "settings":
            return target.evals.settings();
        }
      }),
  );

  server.registerTool(
    "lbb_commit",
    {
      description:
        "Write graph facts, retract them, or label ranked results. mode=facts writes triplets/embeddings/properties; mode=retract removes a wrongly-added fact (by edge or by entity) without a full reset; mode=search_feedback stores query/result relevance labels (Feedback grades: 3=ideal/good, 1=partial, 0=bad; include query, search_id when available, target, rank, score). Explicit idempotency_key wins; when omitted, MCP derives a stable content hash so content-identical retries dedupe. Facts mode defaults edge_idempotency to append; pass skip_unchanged for re-runnable backfills.",
      inputSchema: {
        idempotency_key: z.string().optional(),
        mode: z.enum(["facts", "retract", "search_feedback"]).optional(),
        triplets: z
          .array(
            z.object({
              source: z.object({ type: z.string(), name: z.string() }),
              relation: z.string(),
              target: z.object({ type: z.string(), name: z.string() }),
              confidence: z.number().min(0).max(1).optional(),
              evidence: z.unknown().optional(),
              valid_time: z
                .object({
                  start: z.string().optional(),
                  end: z.string().optional(),
                  granularity: z
                    .enum(["instant", "day", "month", "year", "unknown"])
                    .optional(),
                  source_text: z.string().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
        entity_embeddings: z
          .array(z.record(z.string(), z.unknown()))
          .optional(),
        entity_properties: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Typed scalar attributes per entity. Each item is { type, name, properties }. " +
              "`properties` is a flat map of field -> value, e.g. " +
              '{ "type": "PERSON", "name": "Ada Lovelace", "properties": { "h_index": 52, "title": "VP", "last_contact": "2026-06-26" } }. ' +
              "Values are coerced to each field's declared type, so a string like " +
              '"2026-06-26" lands in a date_time field and "52" in an i64 field. ' +
              "(The verbose form [{ field, value: { i64: 52 } }] is also accepted.) " +
              "Register a field first with lbb_configure evolve_ontology add_property; " +
              "the commit response echoes written_properties so you can confirm what landed.",
          ),
        search_feedback: searchFeedbackSchema.optional(),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Validate a facts commit and return its structured SHACL report without writing. Only supported for mode=facts.",
          ),
        observed_at: z
          .string()
          .optional()
          .describe(
            "Backfill timestamp (RFC3339). Records this commit AS OF that instant: stamps transaction time and defaults each triplet's valid_time.start. Replay history in order with observed_at per commit so as-of reads by date work. Omit for live writes.",
          ),
        edge_idempotency: z
          .enum(["skip_unchanged", "append"])
          .optional()
          .describe(
            "Defaults to append in MCP. Use skip_unchanged for backfills; it skips exact current-edge duplicates and drops evidence-only repeats.",
          ),
        retract_edges: z
          .array(
            z.object({
              source: z.object({ type: z.string(), name: z.string() }),
              relation: z.string(),
              target: z.object({ type: z.string(), name: z.string() }),
            }),
          )
          .optional()
          .describe(
            "mode=retract: specific edges to remove, matched by (source, relation, target).",
          ),
        retract_entities: z
          .array(z.object({ type: z.string(), name: z.string() }))
          .optional()
          .describe(
            "mode=retract: entities whose every current edge is removed (a current-state tombstone; the record and its history are kept for as_of reads).",
          ),
        ...graphScope,
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({
      idempotency_key,
      mode,
      triplets,
      entity_embeddings,
      entity_properties,
      search_feedback,
      dry_run,
      observed_at,
      edge_idempotency,
      retract_edges,
      retract_entities,
      graph,
      branch,
    }) =>
      run(client, "lbb_commit", "standard", () => {
        const commitMode =
          mode ??
          (search_feedback
            ? "search_feedback"
            : retract_edges || retract_entities
              ? "retract"
              : "facts");
        if (dry_run && commitMode !== "facts")
          throw new Error(
            "dry_run is supported only for lbb_commit mode=facts",
          );
        if (commitMode === "retract") {
          const edges = retract_edges ?? [];
          const entities = retract_entities ?? [];
          if (edges.length === 0 && entities.length === 0) {
            throw new Error(
              "lbb_commit mode=retract requires retract_edges or retract_entities",
            );
          }
          const key =
            idempotency_key ??
            contentHashKey(
              { graph, branch },
              { mode: "retract", edges, entities },
            );
          return scoped(client, graph, branch).retract(
            { edges, entities } as never,
            {
              idempotencyKey: key,
            },
          );
        }
        if (commitMode === "search_feedback") {
          if (!search_feedback)
            throw new Error(
              "lbb_commit mode=search_feedback requires search_feedback",
            );
          const key =
            idempotency_key ??
            contentHashKey(
              { graph, branch },
              { mode: "search_feedback", search_feedback },
            );
          return scoped(client, graph, branch).searchFeedback(
            search_feedback as never,
            { idempotencyKey: key },
          );
        }
        if (search_feedback) {
          throw new Error(
            "lbb_commit facts mode cannot include search_feedback",
          );
        }
        const payload = {
          triplets: triplets ?? [],
          entity_embeddings: entity_embeddings ?? [],
          entity_properties: entity_properties ?? [],
          ...(observed_at ? { observed_at } : {}),
          edge_idempotency: edge_idempotency ?? "append",
        };
        if (
          payload.triplets.length === 0 &&
          payload.entity_embeddings.length === 0 &&
          payload.entity_properties.length === 0
        ) {
          throw new Error(
            "lbb_commit requires at least one triplet, entity embedding, or entity property",
          );
        }
        const key =
          idempotency_key ?? contentHashKey({ graph, branch }, payload);
        if (dry_run)
          return scoped(client, graph, branch).commitDryRun(payload as never);
        return scoped(client, graph, branch).commit(payload as never, {
          idempotencyKey: key,
        });
      }),
  );

  server.registerTool(
    "lbb_configure",
    {
      description:
        "Manage native schema metadata. Actions: define_ontology (friendly spec with super_types), evolve_ontology (ordered edits including add_super_types), publish_schema (SHACL activation). All support dry_run previews. Definition/import here extracts native metadata; it does NOT store the complete RDF/OWL document as queryable graph facts. Use lbb_rdf import for full OWL and lbb_rdf update for additive INSERT DATA revisions; RDF deletions are unsupported. Publish_schema accepts unchanged ontology plus shapes; use define/evolve for native ontology changes. Publication enqueues durable conformance; a preview does not validate the whole graph.",
      inputSchema: configureWireSchema,
      annotations: MUTATING,
    },
    (rawArgs) => {
      const parsed = configureInputSchema.safeParse(rawArgs);
      if (!parsed.success) return errorResult(parsed.error);
      const args = parsed.data;
      return run(client, `lbb_configure.${args.action}`, "standard", () => {
        if (args.action === "define_ontology") {
          return client
            .withScope({ graph: args.graph, branch: args.branch })
            .ontologyDefine(
              ontologyDefineBody({
                entity_types: args.entity_types,
                relations: args.relations,
                source: args.source,
                format: args.format,
                merge_default: args.merge_default,
                dry_run: args.dry_run,
              }) as never,
            );
        }
        if (args.action === "evolve_ontology") {
          return scoped(client, args.graph, args.branch).ontology.evolve(
            {
              ops: args.ops,
              allow_data_conflicts: args.allow_data_conflicts ?? false,
            } as never,
            { dryRun: args.dry_run },
          );
        }
        if (args.shapes === undefined) {
          throw new Error(
            "publish_schema requires a SHACL shapes source; use define_ontology or evolve_ontology for native metadata changes",
          );
        }
        return scoped(client, args.graph, args.branch).schema.publish(
          {
            ontology: args.ontology,
            shapes: args.shapes,
            desired_mode: args.desired_mode,
            confirm_restrictive: args.confirm_restrictive,
          } as never,
          { dryRun: args.dry_run },
        );
      });
    },
  );

  server.registerTool(
    "lbb_branch",
    {
      description:
        "Branch lifecycle. Actions: create (fork a new branch off from_branch — the tool's `branch` argument names the NEW branch) and merge (validate-then-merge: replay from_branch's post-fork commits onto the scoped target branch — its fork parent — as ONE commit with event ids preserved; SHACL-validates the would-be merged state first and refuses with the report on violations; a fact superseded on the target after the fork wins over the branch's version, reported as a supersedure_race conflict; delete_source consumes the merged branch).",
      inputSchema: {
        action: z
          .enum(["create", "merge"])
          .describe(
            "create = fork a new branch; merge = replay a child branch onto its fork parent",
          ),
        from_branch: z
          .string()
          .describe(
            "create: the branch to fork from; merge: the child branch whose commits are replayed",
          ),
        validate: z
          .boolean()
          .optional()
          .describe(
            "merge only: refuse on SHACL violations of the would-be merged state (default true)",
          ),
        delete_source: z
          .boolean()
          .optional()
          .describe(
            "merge only: delete every object under the merged branch after success",
          ),
        ...graphScope,
      },
      annotations: MUTATING,
    },
    ({ action, from_branch, validate, delete_source, graph, branch }) =>
      run(client, `lbb_branch.${action}`, "standard", () => {
        const target = scoped(client, graph, branch);
        if (action === "create") return target.createBranch({ from_branch });
        return target.mergeBranch({
          from_branch,
          validate: validate ?? true,
          delete_source: delete_source ?? false,
        });
      }),
  );

  server.registerTool(
    "lbb_observe",
    {
      description:
        "Remember a conversation: store the turns verbatim as an EPISODE evidence entity, then anchor + gate the supplied facts on an observe branch (LLM extraction cannot poison the main graph). Facts with both endpoints already in the graph are anchored; unanchored facts need confidence >= 0.8 to mint new entities, else they come back needs_review. auto_merge merges the branch onto the scoped branch when SHACL validation is clean (the validate-then-merge). Server flag-gated (--enable-observe). This build takes caller-extracted facts (each with a structured triplet); bare statements come back needs_review.",
      inputSchema: {
        session_id: z
          .string()
          .describe(
            "Caller's conversation id (drives the default observe branch name)",
          ),
        turns: z
          .array(
            z.object({
              role: z.string().describe("user | assistant | tool"),
              content: z.string(),
              name: z.string().optional(),
              ts: z.string().optional().describe("RFC 3339 timestamp"),
            }),
          )
          .min(1)
          .describe("The conversation slice to remember (stored verbatim)"),
        source: z
          .string()
          .optional()
          .describe("Source label, e.g. support-bot"),
        facts: z
          .array(
            z.object({
              fact: z.string().describe("Natural-language statement"),
              confidence: z.number().optional().describe("0..1 (default 0.9)"),
              triplet: jsonObjectSchema
                .optional()
                .describe(
                  "Structured form {source:{type,name}, relation, target:{type,name}} — required for the fact to commit",
                ),
            }),
          )
          .optional()
          .describe(
            "Caller-extracted candidate facts; omit with extract:false to store the episode only",
          ),
        extract: z
          .boolean()
          .optional()
          .describe("false = store the episode only (default true)"),
        observe_branch: z
          .string()
          .optional()
          .describe(
            "Branch for the facts (default observe-<hash12(session_id)>)",
          ),
        auto_merge: z
          .boolean()
          .optional()
          .describe("Merge onto the scoped branch when validation is clean"),
        ...graphScope,
      },
      annotations: MUTATING,
    },
    ({
      session_id,
      turns,
      source,
      facts,
      extract,
      observe_branch,
      auto_merge,
      graph,
      branch,
    }) =>
      run(client, "lbb_observe", "standard", () =>
        scoped(client, graph, branch).observe({
          episode: { turns, session_id, source },
          extract: extract ?? true,
          extraction: { byo_completion: (facts ?? []) as never },
          branch: observe_branch,
          auto_merge: auto_merge ?? false,
        } as never),
      ),
  );
}
