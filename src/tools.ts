import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LbbClient } from "@littlebigbrain/client";
import { z } from "zod";
import { metadataPage } from "./metadata-pages.js";
import {
  answerQuestion,
  type QuestionArgs,
  type QuestionProgress,
} from "./question.js";
import {
  commitAt,
  compareQuery,
  describeGraph,
  findNames,
  type CommitAtArgs,
  type CompareArgs,
  type DescribeArgs,
  type NamesArgs,
} from "./query-tools.js";
import { registerRdfTool } from "./rdf-tool.js";
import { registerFilesTool } from "./files-tool.js";
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
  yearMonthSchema,
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
  registerFilesTool(server, client);
  server.registerTool(
    "lbb_inspect",
    {
      description:
        "Read graph context and exact graph facts. Actions: guide, graphs, publication, ontology, ontology_conformance, schema, ontology_search, metadata, entity, ontology_suggestions. graphs works before bootstrap; ontology_suggestions lists the ontology change suggestions that wait for review (or were decided); fact_count is how many graph facts (triplets and entity property rows) accepting one commits, and identity_count how many identities it links. publication reports whether writes are queryable. ontology and schema return complete entries with page_size, section and cursor; follow next until absent. schema reads active native ontology/SHACL metadata without running validation. Query asserted RDF/OWL axioms separately with lbb_query. ontology_conformance serves the durable report referenced by the pinned published root. entity returns one node's attributes and current relationships from the RDF read. For a node's past values, run SPARQL with as_of_commit_seq through lbb_query. Use lbb_query with SPARQL property paths for precise path selection.",
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
        const target = scoped(client, args.graph);
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
          case "ontology_suggestions":
            return target.ontology.suggestions.list({
              status: args.status,
              limit: args.limit ?? 50,
            });
          case "entity":
            if (args.as_of !== undefined) {
              throw new Error(
                "entity valid-time as_of is not supported; use as_of_commit_seq for a retained commit snapshot",
              );
            }
            return target.entityDetail({
              ...(args.entity_id
                ? { id: args.entity_id }
                : {
                    type: requireString(args.entity_type, "entity_type"),
                    name: requireString(args.name, "name"),
                  }),
              asOfCommitSeq: args.as_of_commit_seq,
            });
        }
      });
    },
  );

  server.registerTool(
    "lbb_query",
    {
      description:
        "Analytical and expert reads. Modes: question (a question in plain words), structured (SPARQL-subset JSON body), sparql (SPARQL text), search (instances by meaning over every searchable class; filter narrows by class and relationship; every hit checked against the graph), analyze, and four tools for writing your own queries: names, describe, commit_at, compare. names: before a query that names an entity (a person, a company), find its IRI with text=<the question or the names>; use the first candidate, not a CONTAINS match on the name. describe: before a query on classes or properties you have not seen, read them with question=<the question> (or classes/properties as IRIs): how many sampled instances hold each property (a filter on a rare one returns few rows), the values of small classes such as stages, examples and schema statements. commit_at: for a question about a date, find the commit of date=YYYY-MM-DD (or moment=RFC 3339), then run mode=sparql as_of_commit_seq=<it>. compare: for what changed between two points, run one SELECT at before and after (default the latest) with key=[the entity variable]; added, removed and changed come with totals and pages (next). Use mode=question when you have a question in plain words and no SPARQL query: the server picks the kind of question (route), runs queries in a bounded loop, reads their rows, and answers in plain words (about 8 s). The result holds the answer with citations and a chart hint (kind, x, y: columns of the rows), the steps, the route, and the query and rows the answer stands on. Continue or correct that query with mode=sparql. Each question uses model tokens and counts toward a daily limit of the stack. SPARQL is the query language; search finds what the words describe. SPARQL text can also search by meaning inside the query with ?x <https://littlebigbrain.com/search#similarTo> \"words\", so the other patterns filter and join the hits in one query; the result's search field reports the plan. To plan a search: lbb_embeddings action=list, then SPARQL for a class's relationships on a sample, then mode=search with explain=true to check the resolved filter before the real search (lbb_inspect action=guide has the queries). Relations are <https://littlebigbrain.com/r/NAME> and types <https://littlebigbrain.com/class/NAME> (both lowercased); entities are content-addressed, so anchor a named one by its rdfs:label rather than building its IRI. Structured and text queries pin one published watermark for the request.",
      inputSchema: queryWireSchema,
      annotations: READ_ONLY,
    },
    (rawArgs, extra) => {
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
            assertCursorScope({ graph: args.graph }, cursor);
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
            const offset = cursor?.offset ?? 0;
            const target = scoped(client, graph);
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
              extra?: Record<string, unknown>,
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
                  { textFormat: options.queryTextFormat, notes, extra },
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
            // A query with a search:similarTo pattern reports how the search
            // ran; keep that report whole next to the rows.
            const search = response.search ?? undefined;
            if (search && !search.complete) {
              notes.push(
                `search bound ${search.hits} of the ${search.top} hits asked for (complete: false): fewer entities satisfy the rest of the query among the candidates the search may score. When at most 20,000 entities match the other patterns, the search scores every match.`,
              );
            }
            const rerank = search?.rerank ?? undefined;
            if (rerank && rerank.status !== "applied") {
              notes.push(
                `search:rerank did not apply (${rerank.status}${rerank.error ? `: ${rerank.error}` : ""}): the rows hold the most similar hits, and the relevance variable is unbound.`,
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
              search ? { search } : undefined,
            );
            return render(sparqlEnvelope);
          } catch (error) {
            return errorResult(await enrichError(client, error));
          }
        })();
      }
      if (args.mode === "question") {
        const questionArgs = args as QuestionArgs;
        // A call with a progress token gets one notification per step of
        // the server's work; the result is the same.
        const progressToken = extra._meta?.progressToken;
        const progress: QuestionProgress | undefined =
          progressToken === undefined
            ? undefined
            : {
                signal: extra.signal,
                report: (progress, message) =>
                  extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress, message },
                  }),
              };
        return (async () => {
          try {
            return await answerQuestion(
              client,
              questionArgs,
              options.queryTextFormat,
              progress,
            );
          } catch (error) {
            return errorResult(await enrichError(client, error));
          }
        })();
      }
      if (
        args.mode === "names" ||
        args.mode === "describe" ||
        args.mode === "commit_at" ||
        args.mode === "compare"
      ) {
        const toolArgs = args as Record<string, unknown>;
        return (async () => {
          try {
            switch (args.mode) {
              case "names":
                return await findNames(
                  client,
                  toolArgs as unknown as NamesArgs,
                );
              case "describe":
                return await describeGraph(
                  client,
                  toolArgs as unknown as DescribeArgs,
                );
              case "commit_at":
                return await commitAt(
                  client,
                  toolArgs as unknown as CommitAtArgs,
                );
              default:
                return await compareQuery(
                  client,
                  toolArgs as unknown as CompareArgs,
                );
            }
          } catch (error) {
            return errorResult(await enrichError(client, error));
          }
        })();
      }
      if (args.mode === "search") {
        const searchArgs = args;
        // The caller's detail shapes the hits like every other mode: compact
        // trims to 5 hits of 300 characters, standard and full return more.
        return run(client, "lbb_query.search", searchArgs.detail, async () => {
          const target = scoped(client, searchArgs.graph);
          return target.embeddings.search({
            embedding: searchArgs.embedding,
            text: searchArgs.text,
            top_k: searchArgs.top_k,
            probe: searchArgs.probe,
            include: searchArgs.include,
            request: searchArgs.request,
            filter: searchArgs.filter,
            explain: searchArgs.explain,
            rerank: searchArgs.rerank,
          });
        });
      }
      return run(client, `lbb_query.${args.mode}`, args.detail, async () => {
        const target = scoped(client, args.graph);
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
        "Read model-training inputs or compare retrieval configurations over one pinned published snapshot, or read what the managed models did. shadow_eval takes the API ShadowEvalRequest body; dataset actions return bounded training examples at an optional signal split. activity reads one month of the stack's model use (all graphs): calls, items, estimated tokens and cost per feature (index, search, fit, judge, training) and model, by day and by graph, the months with activity, and the model each feature uses now.",
      inputSchema: {
        action: z.enum([
          "shadow_eval",
          "suggest_dataset",
          "extractor_dataset",
          "activity",
        ]),
        body: jsonObjectSchema.optional(),
        limit: z.number().int().positive().optional(),
        split_seq: z.number().int().nonnegative().optional(),
        month: yearMonthSchema
          .optional()
          .describe(
            "activity: the month, yyyy-mm (UTC). Defaults to the current month.",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    ({ action, body, limit, split_seq, month, detail, graph }) =>
      run(client, `lbb_models.${action}`, detail, () => {
        const target = scoped(client, graph);
        switch (action) {
          case "shadow_eval":
            if (!body) throw new Error("shadow_eval requires body");
            return target.shadowEval(body as never);
          case "suggest_dataset":
            return target.suggestDataset({ limit, splitSeq: split_seq });
          case "extractor_dataset":
            return target.extractorDataset({ limit, splitSeq: split_seq });
          case "activity":
            return target.modelActivity({ month });
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
    title: z
      .string()
      .optional()
      .describe(
        'preview/declare: the field that names each hit, e.g. "display_name". Omit for the ontology\'s name property (skos:prefLabel, a property declared rdfs:subPropertyOf rdfs:label, else rdfs:label); on an existing embedding, omit to keep its name. preview reports title_source and, when the labels read as keys, title_suggestion.',
      ),
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
    title?: string;
    model?: string;
    dim?: number;
  }) => {
    if (!args.class) throw new Error("this action requires class");
    return {
      class: args.class,
      ...(args.name ? { name: args.name } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.exclude ? { exclude: args.exclude } : {}),
      ...(args.title ? { title: args.title } : {}),
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
        const target = scoped(client, args.graph);
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
        const target = scoped(client, args.graph);
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
    ({ name, confirm, detail, graph }) =>
      run(client, "lbb_embeddings_delete", detail, () => {
        if (confirm !== name) {
          throw new Error("confirm must repeat the embedding name");
        }
        return scoped(client, graph).embeddings.delete(name);
      }),
  );

  // Fit from text: fit sources declared on classes, like embeddings.
  const fitSetup = {
    class: z
      .string()
      .optional()
      .describe(
        "preview/declare/dry_run: the class IRI whose instances hold the text.",
      ),
    from: z
      .array(z.string())
      .optional()
      .describe(
        "preview/declare/dry_run: the fields that hold the text, as embedding paths (transcript, label, about/label, <https://…>). Omit for the long text facts of the class.",
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        "preview/declare/dry_run: fields to drop from the automatic choice.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        'preview/declare/dry_run: one sentence about the text, e.g. "interviews with employees about their work processes" (at most 500 characters).',
      ),
  };
  const fitDeclaration = (args: {
    class?: string;
    name?: string;
    from?: string[];
    exclude?: string[];
    context?: string;
  }) => {
    if (!args.class) throw new Error("this action requires class");
    return {
      class: args.class,
      ...(args.name ? { name: args.name } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.exclude ? { exclude: args.exclude } : {}),
      ...(args.context ? { context: args.context } : {}),
    };
  };

  server.registerTool(
    "lbb_fit_sources",
    {
      description:
        "Fit from text, read only: fit sources declared on classes. A fit source names the fields of a class that hold text (transcripts, documents); the server reads every instance, proposes ontology changes (classes, properties, relations) with verbatim quotes, checks them, and files them as ontology suggestions with origin id fit:<name>. list shows each source's status (progress, lag, instances read, proposals kept and dropped, suggestions per status, this month's spend, last error) and the stack's monthly budget; get shows one; preview shows the fields, every candidate field of the class and the text of sample instances, calls no model and stores nothing. Declare, refresh or dry-run with lbb_fit_sources_manage; list the suggestions with lbb_inspect action=ontology_suggestions.",
      inputSchema: {
        action: z.enum(["list", "get", "preview"]),
        name: z.string().optional().describe("get: the fit source name."),
        ...fitSetup,
        sample: z.number().int().positive().max(20).optional(),
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
      run(client, `lbb_fit_sources.${args.action}`, args.detail, () => {
        const fit = scoped(client, args.graph).ontology.fitSources;
        switch (args.action) {
          case "list":
            return fit.list();
          case "get":
            if (!args.name) throw new Error("get requires name");
            return fit.get(args.name);
          case "preview":
            return fit.preview({
              ...fitDeclaration(args),
              ...(args.sample ? { sample: args.sample } : {}),
              ...(args.iris ? { iris: args.iris } : {}),
            });
        }
      }),
  );

  server.registerTool(
    "lbb_fit_sources_manage",
    {
      description:
        "Declare, dry-run or refresh a fit source (fit from text). Run lbb_fit_sources action=preview first and show the user the text the fit reads. dry_run runs the models on the first part of up to 3 instances (at most 60 s; truncated when one did not finish) and returns every proposal with its quote, its support score and what the checks made of it; it files nothing but spends model budget. declare sets the class, the fields and the context; the job then reads every instance and files suggestions (an existing source changes only what you name). refresh asks the job to run now and returns the status at once; the job also runs by itself after each published commit, so poll lbb_fit_sources action=get for progress. Nothing changes the ontology until a person accepts a suggestion.",
      inputSchema: {
        action: z.enum(["declare", "dry_run", "refresh"]),
        name: z
          .string()
          .optional()
          .describe("The fit source name (refresh: required)."),
        ...fitSetup,
        detail: detailSchema,
        ...graphScope,
      },
      annotations: MUTATING,
    },
    (args) =>
      run(client, `lbb_fit_sources_manage.${args.action}`, args.detail, () => {
        const fit = scoped(client, args.graph).ontology.fitSources;
        switch (args.action) {
          case "declare":
            return fit.declare(fitDeclaration(args));
          case "dry_run":
            return fit.preview({ ...fitDeclaration(args), propose: true });
          case "refresh":
            if (!args.name) throw new Error("refresh requires name");
            return fit.refresh(args.name);
        }
      }),
  );

  server.registerTool(
    "lbb_fit_sources_delete",
    {
      description:
        "Delete a fit source: the fit stops reading its class. The suggestions it filed stay. Ask the user first; confirm must repeat the name.",
      inputSchema: {
        name: z.string().describe("The fit source name."),
        confirm: z.string().describe("The same name again, to confirm."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: DESTRUCTIVE,
    },
    ({ name, confirm, detail, graph }) =>
      run(client, "lbb_fit_sources_delete", detail, () => {
        if (confirm !== name) {
          throw new Error("confirm must repeat the fit source name");
        }
        return scoped(client, graph).ontology.fitSources.delete(name);
      }),
  );

  // Starter workflows and triggered workflows: one API over everything that
  // runs when a class of the graph changes. search.embed and ontology.fit
  // are the embeddings and fit sources above, through the same stored
  // documents.
  const workflowSetup = {
    starter: z
      .string()
      .optional()
      .describe(
        "The starter workflow's catalog id from action=starters, e.g. search.embed (embeddings on a class), ontology.fit (fit from text) or workflow (a developer workflow: your worker's workflow gets the instances). get/preview/use/refresh/pause/resume: required.",
      ),
    class: z
      .string()
      .optional()
      .describe(
        "preview/use: the class whose instances the workflow watches (an IRI, or a name the ontology knows). Required unless the starter workflow's watch is fixed.",
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        "preview/use: the fields whose change triggers the workflow, as embedding paths (transcript, label, about/label, <https://…>). Omit for the starter workflow's own choice.",
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe("preview/use: fields to drop from the automatic choice."),
    params: jsonObjectSchema
      .optional()
      .describe(
        'preview/use: the starter workflow\'s own settings, as listed in its catalog entry: search.embed takes model, dim and title; ontology.fit takes context (one sentence about the text, e.g. {"context": "interviews with employees"}); workflow takes none.',
      ),
    workflow: z
      .object({
        workflow_type: z
          .string()
          .describe("The workflow type your worker serves, e.g. word-count."),
        version: z.string().describe("Its version, e.g. v1."),
      })
      .strict()
      .optional()
      .describe(
        "preview/use, developer workflow (starter=workflow) only, required there: the workflow of your worker that receives the messages. Creating it creates the instance starter.<name>.",
      ),
    owns: z
      .object({
        classes: z.array(z.string()).max(64).optional(),
        relations: z.array(z.string()).max(64).optional(),
        properties: z.array(z.string()).max(64).optional(),
      })
      .strict()
      .optional()
      .describe(
        "preview/use, developer workflow only: what your code writes. classes it creates instances of, relations it writes as out-edges of the watched instances, properties it writes on them. Owned outputs never trigger the workflow itself.",
      ),
    batch: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "preview/use, developer workflow only: instances per message, 1 to 64 (default 16).",
      ),
  };
  const workflowRequest = (args: {
    starter?: string;
    name?: string;
    class?: string;
    fields?: string[];
    exclude?: string[];
    params?: Record<string, unknown>;
    gate?: number;
    budget_usd_per_month?: number;
    workflow?: { workflow_type: string; version: string };
    owns?: { classes?: string[]; relations?: string[]; properties?: string[] };
    batch?: number;
  }) => {
    if (!args.starter) throw new Error("this action requires starter");
    if (!args.class && (args.fields || args.exclude)) {
      throw new Error("fields and exclude need class");
    }
    return {
      starter: args.starter,
      ...(args.name ? { name: args.name } : {}),
      ...(args.class
        ? {
            watch: {
              class: args.class,
              ...(args.fields ? { fields: args.fields } : {}),
              ...(args.exclude ? { exclude: args.exclude } : {}),
            },
          }
        : {}),
      ...(args.params ? { params: args.params } : {}),
      ...(args.gate !== undefined ? { gate: { below: args.gate } } : {}),
      ...(args.budget_usd_per_month !== undefined
        ? { budget_usd_per_month: args.budget_usd_per_month }
        : {}),
      ...(args.workflow ? { workflow: args.workflow } : {}),
      ...(args.owns ? { owns: args.owns } : {}),
      ...(args.batch !== undefined ? { batch: args.batch } : {}),
    };
  };
  const workflowRef = (args: { starter?: string; name?: string }) => {
    if (!args.starter || !args.name) {
      throw new Error("this action requires starter and name");
    }
    return { starter: args.starter, name: args.name };
  };

  server.registerTool(
    "lbb_workflows",
    {
      description:
        "Starter workflows and triggered workflows, read only. A starter workflow is a template; a triggered workflow is a workflow created from one on the graph. It watches a class: when a published commit adds or changes instances of the class (or changes the watched fields), the workflow reads them and does its work. search.embed keeps an embedding of the class (the same as lbb_embeddings); ontology.fit reads text fields and files ontology suggestions (the same as lbb_fit_sources); workflow (a developer workflow) sends the new and changed instances to a workflow of the developer's worker as trigger messages, and that code writes the facts the workflow owns. documents.parse reads uploaded PDF files into pages with line boxes, documents.link writes DocEntry and DocMention instances and links each mention to its entry, and infer.llm fills chosen properties from text, each value with a quote; read the files and their pages with lbb_files. starters lists the starter workflows this server offers with their group, settings and whether each can run here. list shows every triggered workflow of the graph with its state (backfilling, ready, paused, failed, unavailable), lag, counters, this month's spend and last error; get shows one (starter and name) with its own status in details (for workflow: the messages sent, the instances waiting, the message in flight and whether it is paused). preview shows what creating one would do (the resolved watch, the instance count and the workflow's own preview; for workflow, the first messages it would send), calls no model and stores nothing. Message workflows of the workflow engine are not listed here. Create, refresh, pause or resume with lbb_workflows_manage; delete with lbb_workflows_delete.",
      inputSchema: {
        action: z.enum(["starters", "list", "get", "preview"]),
        name: z
          .string()
          .optional()
          .describe(
            "get: the triggered workflow's name. preview: the name a new workflow would get.",
          ),
        ...workflowSetup,
        sample: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("preview: how many sample instances to show."),
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
      run(client, `lbb_workflows.${args.action}`, args.detail, () => {
        const workflows = scoped(client, args.graph).workflows;
        switch (args.action) {
          case "starters":
            return workflows.starters.list();
          case "list":
            return workflows.triggered.list();
          case "get":
            return workflows.triggered.get(workflowRef(args));
          case "preview":
            return workflows.triggered.preview({
              ...workflowRequest(args),
              ...(args.sample ? { sample: args.sample } : {}),
              ...(args.iris ? { iris: args.iris } : {}),
            });
        }
      }),
  );

  server.registerTool(
    "lbb_workflows_manage",
    {
      description:
        "Create a workflow from a starter workflow, or refresh, pause or resume a triggered workflow. Run lbb_workflows action=preview first and show the user the watch and the instance count. use creates a workflow from a starter workflow of action=starters, under a name (default: the class's local name), with its watch (class, fields) and params; the workflow then reads every instance of the class and follows each published commit. A developer workflow (starter=workflow) also takes workflow (workflow_type and version of the developer's worker), owns and batch; it needs a server with the workflow engine. use again with the same starter and name changes only what you name, and the same request again changes nothing. A workflow that calls models (ontology.fit, documents.link, infer.llm) spends model budget as it reads. refresh asks the workflow to run now and returns at once with queued; poll lbb_workflows action=get for progress. pause stops a workflow (a developer workflow, documents.parse, documents.link or infer.llm) from reading and sending; resume lets it catch up. search.embed and ontology.fit cannot be paused.",
      inputSchema: {
        action: z.enum(["use", "refresh", "pause", "resume"]),
        name: z
          .string()
          .optional()
          .describe(
            "The triggered workflow's name, [a-z0-9][a-z0-9-]{0,62} (refresh, pause, resume: required; use: omit for the class's local name).",
          ),
        ...workflowSetup,
        gate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "use: outputs below this confidence go to review instead of the graph, for a workflow with a review gate.",
          ),
        budget_usd_per_month: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "use: a monthly model budget in USD for this workflow, below the stack's own.",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: MUTATING,
    },
    (args) =>
      run(client, `lbb_workflows_manage.${args.action}`, args.detail, () => {
        const workflows = scoped(client, args.graph).workflows;
        switch (args.action) {
          case "use":
            return workflows.starters.use(workflowRequest(args));
          case "refresh":
            return workflows.triggered.refresh(workflowRef(args));
          case "pause":
            return workflows.triggered.pause(workflowRef(args), true);
          case "resume":
            return workflows.triggered.pause(workflowRef(args), false);
        }
      }),
  );

  server.registerTool(
    "lbb_workflows_delete",
    {
      description:
        "Delete a triggered workflow: it stops following its class, and what it wrote stays. Deleting search.embed deletes the embedding and its vectors, so its class stops being searchable; the suggestions an ontology.fit filed stay; a developer workflow leaves its workflow instance and the facts its code wrote. Ask the user first; confirm must repeat the name.",
      inputSchema: {
        starter: z
          .string()
          .describe("The starter workflow's catalog id, e.g. search.embed."),
        name: z.string().describe("The triggered workflow's name."),
        confirm: z.string().describe("The same name again, to confirm."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: DESTRUCTIVE,
    },
    ({ starter, name, confirm, detail, graph }) =>
      run(client, "lbb_workflows_delete", detail, () => {
        if (confirm !== name) {
          throw new Error("confirm must repeat the workflow name");
        }
        return scoped(client, graph).workflows.triggered.delete({
          starter,
          name,
        });
      }),
  );

  const modelUse = z
    .enum(["ask", "route", "rerank", "fit", "label"])
    .describe(
      "A use of a model: ask = question answers, route = query routing, rerank = search rerank, fit = ontology fit, label = eval labels.",
    );

  server.registerTool(
    "lbb_model_choice",
    {
      description:
        "Model choice, read only: which model each use of a model on the graph runs, and trials that test other models against the graph's ground truth (the checked calls: a person's review, else the judge's verdict). options shows per use the model it runs now (current), LBB's model (default), a switch (switched), its checked calls, and the models a trial can test with their efforts, prices and whether the server holds their key; available=false with a reason when trials cannot run. trials lists the trials, newest first, each with its report: calls compared, both models' right share, mean score (0 to 1), cost per call and median time, the difference with its 95% interval (delta, ci_low, ci_high), outcome (too_few, better, same, worse) and qualifies (meets the bar: at least 20 calls, at most 5 points worse at the low end, no more failures, cheaper or better). trial reads one trial with its compared calls; trial_call reads one call with both answers and the ground truth. switches lists the switched uses. Start, stop, switch or revert with lbb_model_choice_manage.",
      inputSchema: {
        action: z.enum([
          "options",
          "trials",
          "trial",
          "trial_call",
          "switches",
        ]),
        trial_id: z
          .string()
          .optional()
          .describe("trial / trial_call: the trial id."),
        call_id: z
          .string()
          .optional()
          .describe("trial_call: a call id from the trial's calls."),
        job: modelUse
          .optional()
          .describe("trials: only the trials of this use."),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("trials: at most this many, newest first (default 20)."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(client, `lbb_model_choice.${args.action}`, args.detail, () => {
        const models = scoped(client, args.graph).models;
        switch (args.action) {
          case "options":
            return models.trials.options();
          case "trials":
            return models.trials.list({ job: args.job, limit: args.limit });
          case "trial":
            if (!args.trial_id) throw new Error("trial requires trial_id");
            return models.trials.get(args.trial_id);
          case "trial_call":
            if (!args.trial_id || !args.call_id) {
              throw new Error("trial_call requires trial_id and call_id");
            }
            return models.trials.call(args.trial_id, args.call_id);
          case "switches":
            return models.switches.list();
        }
      }),
  );

  server.registerTool(
    "lbb_model_choice_manage",
    {
      description:
        "Model choice, writes. start tests a candidate model on the uses in jobs (without jobs, every use it can do that has checked calls): the server answers those checked calls again with the candidate and scores it and the model in use against the same ground truth. It changes no model and spends at most the trial budget ($3.00 by default) of model and judge cost; an open trial of the same use and candidate comes back as it is. Pick candidates from lbb_model_choice action=options (provider anthropic with an effort, or typesafe jev-latest). A trial runs by itself: poll lbb_model_choice action=trial until its status is no longer running. stop ends a trial; it keeps what it compared. switch makes the trial's use run its candidate on this graph from the next call on; only a trial that qualifies and compared with the model in use switches (ask to a Claude model, route to a Jev model). Show the user the trial's report (score, difference and interval, cost per call, time) and switch only what the user confirmed. revert puts the use back on LBB's model.",
      inputSchema: {
        action: z.enum(["start", "stop", "switch", "revert"]),
        provider: z
          .enum(["anthropic", "typesafe"])
          .optional()
          .describe("start: the candidate's provider."),
        model: z
          .string()
          .optional()
          .describe(
            "start: the candidate model id, e.g. claude-haiku-5-5 or jev-latest.",
          ),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("start: the effort of a Claude candidate."),
        jobs: z
          .array(modelUse)
          .optional()
          .describe("start: the uses to test it on."),
        target: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("start: the calls to compare (default 40)."),
        days: z
          .number()
          .int()
          .positive()
          .max(30)
          .optional()
          .describe("start: the days the trial takes new checks (default 14)."),
        trial_id: z
          .string()
          .optional()
          .describe("stop / switch: the trial id."),
        job: modelUse
          .optional()
          .describe("revert: the use to put back on LBB's model."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: MUTATING,
    },
    (args) =>
      run(client, `lbb_model_choice_manage.${args.action}`, args.detail, () => {
        const models = scoped(client, args.graph).models;
        switch (args.action) {
          case "start":
            if (!args.provider || !args.model) {
              throw new Error("start requires provider and model");
            }
            return models.trials.create({
              candidate: {
                provider: args.provider,
                model: args.model,
                ...(args.effort ? { effort: args.effort } : {}),
              },
              ...(args.jobs ? { jobs: args.jobs } : {}),
              ...(args.target ? { target: args.target } : {}),
              ...(args.days ? { days: args.days } : {}),
            });
          case "stop":
            if (!args.trial_id) throw new Error("stop requires trial_id");
            return models.trials.stop(args.trial_id);
          case "switch":
            if (!args.trial_id) throw new Error("switch requires trial_id");
            return models.switches.create({ trial: args.trial_id });
          case "revert":
            if (!args.job) throw new Error("revert requires job");
            return models.switches.revert(args.job);
        }
      }),
  );

  server.registerTool(
    "lbb_evals",
    {
      description:
        "Managed evals: ground truth for the questions an app asks and the searches it runs. A query run with `request` (lbb_query, also mode=question) records a trace: the question, the query that answered it, the type of that query (`query_type`: sparql, hybrid = search by meaning with conditions, search = search by meaning alone) and one item per result (hit or row); trace reads it back with the item ids. label has two forms. On a question's trace, valid alone judges the whole answer: valid=true makes the trace's query the golden query of the question; valid=false with sparql gives the right query, which becomes the golden query; valid=false alone marks the answer wrong. item + valid (or items) judges one result, a citation of the answer: the ground truth of the hits of a search by meaning, and a result marked wrong must not come back for any type. golden freezes a stored query or a search (every result it returns now is relevant). run checks every golden at the current commit: a question is asked again through the query rewriter, then the type of the query it wrote is compared with the expected type, its rows with the rows of the golden query at the same commit (`query_check`), and its results with the judged results; a search is done again; new results open a review trace. judge lets the platform's judge model (the hosted frontier model) label unlabeled results. summary, traces, goldens, results, and settings read state. Model checks: a judge model checks a sample of the model calls LBB makes for the graph (rerank, route, ask = the answer of a question, rewrite, fit, propose, label). checks_summary reads a month per job and model (checks, score, right, partly, wrong, reviews) and the judge's agreement with people; checks lists the month's checks, newest first, with the judge's verdict, score and reason and the ground truth (`truth`). review_check records a person's review of one check (call_id): agree=true keeps the judge's verdict; agree=false with verdict (and an optional score, reference and note) corrects it. The review becomes the call's ground truth, so show the check to the user and review only what the user confirmed.",
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
          "checks_summary",
          "checks",
          "review_check",
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
            "label: true = the result answers the request (thumbs up), false = it does not. Without item or items, on a question's trace: the whole answer is right (true) or wrong (false).",
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
        note: z
          .string()
          .optional()
          .describe(
            "label / review_check: why. review_check: at most 2,000 characters.",
          ),
        sparql: z
          .string()
          .optional()
          .describe(
            "golden: the query to freeze (the search text for surface=search). label: with valid=false and no item, the right query for the question; the server checks and runs it once.",
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
        month: yearMonthSchema
          .optional()
          .describe(
            "checks_summary / checks: the month, yyyy-mm (UTC). Defaults to the current month.",
          ),
        job: z
          .enum([
            "rerank",
            "route",
            "ask",
            "rewrite",
            "fit",
            "propose",
            "label",
          ])
          .optional()
          .describe("checks: only the checks of one job."),
        verdict: z
          .enum(["right", "partly", "wrong"])
          .optional()
          .describe(
            "checks: only the checks whose ground truth has this verdict. review_check with agree=false: the right verdict.",
          ),
        reviewed: z
          .boolean()
          .optional()
          .describe(
            "checks: true = only the checks a person reviewed, false = only the others.",
          ),
        after: z
          .string()
          .optional()
          .describe("checks: the next_after of the previous page."),
        call_id: z
          .string()
          .optional()
          .describe("review_check: the check's `call` id, from checks."),
        agree: z
          .boolean()
          .optional()
          .describe(
            "review_check: true = the judge is right, false = correct it with verdict.",
          ),
        score: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "review_check with agree=false: the right score, 0 to 1. Omit for the judge's score of that verdict.",
          ),
        reference: jsonObjectSchema
          .optional()
          .describe(
            'review_check with agree=false: the right answer. A rerank or label check: {"grades": {"<hit id>": 0..3}}; a route or fit check: {"picks": {"<question id>": "<option>"}}.',
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
      month,
      job,
      verdict,
      reviewed,
      after,
      call_id,
      agree,
      score,
      reference,
      detail,
      graph,
    }) =>
      run(client, `lbb_evals.${action}`, detail, () => {
        const target = scoped(client, graph);
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
            if (item && valid === undefined)
              throw new Error("label requires valid with item");
            if (!item && !items?.length && valid === undefined)
              throw new Error(
                "label requires item (with valid), items, or valid alone for the answer of a question",
              );
            if (
              sparql !== undefined &&
              (item || items?.length || valid !== false)
            )
              throw new Error(
                "label takes sparql (the right query) only with valid=false and no item",
              );
            return target.evals.label(trace_id, {
              ...(item ? { item, valid } : {}),
              ...(items?.length ? { items } : {}),
              // The answer of a question as a whole.
              ...(!item && !items?.length ? { valid } : {}),
              ...(sparql !== undefined ? { sparql } : {}),
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
          case "checks_summary":
            return target.checks.summary({ month });
          case "checks":
            return target.checks.list({
              job,
              month,
              verdict,
              reviewed,
              after,
              limit,
            });
          case "review_check":
            if (!call_id) throw new Error("review_check requires call_id");
            if (agree === undefined)
              throw new Error("review_check requires agree");
            if (
              agree &&
              (verdict !== undefined ||
                score !== undefined ||
                reference !== undefined)
            )
              throw new Error(
                "review_check with agree=true takes no verdict, score or reference",
              );
            if (!agree && !verdict)
              throw new Error("review_check with agree=false requires verdict");
            return target.checks.review(call_id, {
              agree,
              ...(verdict ? { verdict } : {}),
              ...(score !== undefined ? { score } : {}),
              ...(reference ? { reference } : {}),
              ...(note ? { note } : {}),
            });
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
            contentHashKey({ graph }, { mode: "retract", edges, entities });
          return scoped(client, graph).retract({ edges, entities } as never, {
            idempotencyKey: key,
          });
        }
        if (commitMode === "search_feedback") {
          if (!search_feedback)
            throw new Error(
              "lbb_commit mode=search_feedback requires search_feedback",
            );
          const key =
            idempotency_key ??
            contentHashKey(
              { graph },
              { mode: "search_feedback", search_feedback },
            );
          return scoped(client, graph).searchFeedback(
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
        const key = idempotency_key ?? contentHashKey({ graph }, payload);
        if (dry_run)
          return scoped(client, graph).commitDryRun(payload as never);
        return scoped(client, graph).commit(payload as never, {
          idempotencyKey: key,
        });
      }),
  );

  server.registerTool(
    "lbb_configure",
    {
      description:
        "Manage native schema metadata. Actions: define_ontology (friendly spec with super_types), evolve_ontology (ordered edits including add_super_types), list_starters (the base ontologies crm, documents and work, each with its status on the graph: absent, partial or applied, what applying adds, and conflicts), apply_starter (add what the graph lacks of a starter in one ontology version; a relation the graph has is widened; refused with starter_conflict when the graph holds a term differently; dry_run previews), publish_schema (SHACL activation), suggest_ontology_change (file a change for a person to review instead of applying it; prefer it when the graph's owner reviews ontology changes, and list the result with lbb_inspect action=ontology_suggestions; facts files graph facts for review, which accepting commits after the change, and change may be empty when facts is set), get_rewrite_profile and set_rewrite_profile (the graph's notes and up to 20 worked question-to-SPARQL examples that lbb_query mode=question reads for every question; pass the version you read as expected_version). define, evolve, publish and set_rewrite_profile support dry_run previews. Definition/import here extracts native metadata; it does NOT store the complete RDF/OWL document as queryable graph facts. Use lbb_rdf import for full OWL and lbb_rdf update for additive INSERT DATA revisions; RDF deletions are unsupported. Publish_schema accepts unchanged ontology plus shapes; use define/evolve for native ontology changes. Publication enqueues durable conformance; a preview does not validate the whole graph.",
      inputSchema: configureWireSchema,
      annotations: MUTATING,
    },
    (rawArgs) => {
      const parsed = configureInputSchema.safeParse(rawArgs);
      if (!parsed.success) return errorResult(parsed.error);
      const args = parsed.data;
      return run(client, `lbb_configure.${args.action}`, "standard", () => {
        if (args.action === "define_ontology") {
          return client.withScope({ graph: args.graph }).ontologyDefine(
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
        if (args.action === "suggest_ontology_change") {
          const agent = args.agent ?? "mcp agent";
          const change = args.change ?? [];
          if (!change.length && !args.facts)
            throw new Error(
              "suggest_ontology_change needs change, facts, or both",
            );
          return scoped(client, args.graph).ontology.suggestions.create({
            title: args.title,
            rationale: args.rationale ?? "",
            change,
            ...(args.facts ? { facts: args.facts } : {}),
            origin: { kind: "agent", id: agent, label: agent },
            ...(args.anchor ? { anchor: args.anchor } : {}),
            ...(args.key ? { key: args.key } : {}),
            ...(args.evidence ? { evidence: args.evidence } : {}),
          } as never);
        }
        if (args.action === "list_starters") {
          return scoped(client, args.graph).ontology.starters.list();
        }
        if (args.action === "get_rewrite_profile") {
          return scoped(client, args.graph).query.rewriteProfile();
        }
        if (args.action === "set_rewrite_profile") {
          return scoped(client, args.graph).query.setRewriteProfile(
            {
              notes: args.notes ?? "",
              examples: args.examples ?? [],
              ...(args.expected_version !== undefined
                ? { expected_version: args.expected_version }
                : {}),
            },
            { dryRun: args.dry_run },
          );
        }
        if (args.action === "apply_starter") {
          return scoped(client, args.graph).ontology.starters.apply(
            args.starter,
            {
              dryRun: args.dry_run,
              expectedOntologyVersion: args.expected_ontology_version,
            },
          );
        }
        if (args.action === "evolve_ontology") {
          return scoped(client, args.graph).ontology.evolve(
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
        return scoped(client, args.graph).schema.publish(
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
}
