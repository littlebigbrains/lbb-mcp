import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LbbClient } from "@littlebigbrain/client";
import { z } from "zod";
import {
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
  entityEdgeCapHint,
  enrichError,
  errorResult,
  guide,
  normalizeDetail,
  normalizeLbbIris,
  ontologyDefineBody,
  queryCommitPin,
  queryEnvelope,
  requireString,
  resolveProfile,
  rowPageFrom,
  rowPageNext,
  run,
  schemaPreview,
  schemaPublishBody,
  scoped,
  searchBody,
  searchFeedbackHint,
  stableJson,
  toolResult,
} from "./tool-runtime.js";

export function registerLbbTools(server: McpServer, client: LbbClient): void {
  server.registerTool(
    "lbb_search",
    {
      description:
        "Natural-language retrieval over Little Big Brain. Use `query` for one phrasing, `queries` for reciprocal-rank fusion across phrasings, and `follow_paths: true` when you want bounded graph paths from text-resolved seed entities. When you can judge returned results, call lbb_commit mode=search_feedback with good=3, partial=1, bad=0 so Little Big Brain can build customer-specific qrels for embedding training.",
      inputSchema: {
        query: z.string().optional().describe("Natural-language query"),
        queries: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Multiple phrasings to fuse"),
        mode: z.enum(["hybrid", "bm25", "vector", "lexical"]).optional(),
        follow_paths: z.boolean().optional(),
        top_k: z.number().int().positive().optional(),
        max_hops: z.number().int().positive().max(6).optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
        profile: z
          .enum(["ndcg_v1", "graph_aware_v1", "baseline", "scored_atom_v1"])
          .optional(),
        as_of: z
          .string()
          .optional()
          .describe(
            "Valid-time cursor (RFC 3339): results reflect facts true at this instant",
          ),
        as_of_commit_seq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Snapshot pin: results reproduce the graph as of this commit sequence (echoed back in snapshot.as_of_commit_seq); a pin past head is an error",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    ({
      query,
      queries,
      mode,
      follow_paths,
      top_k,
      max_hops,
      direction,
      profile,
      as_of,
      as_of_commit_seq,
      detail,
      graph,
      branch,
    }) =>
      run(
        client,
        "lbb_search",
        detail,
        () => {
          const target = scoped(client, graph, branch);
          if (queries?.length) {
            return target.multiSearch({
              subqueries: queries.map((q, index) => ({
                id: `q${index}`,
                weight: 1.0,
                request: searchBody({
                  query: q,
                  mode,
                  top_k,
                  profile,
                  as_of,
                  as_of_commit_seq,
                }),
              })),
              top_k: top_k ?? 10,
              explain: false,
            } as never);
          }
          const q = requireString(query, "query");
          if (follow_paths) {
            return target.semanticTraverse({
              query: q,
              seed_top_k: Math.min(top_k ?? 3, 10),
              search: {
                lexical: true,
                bm25: true,
                vector: true,
                bm25_source: "persisted",
                vector_source: "persisted",
                consistency: "strong",
                profile: resolveProfile(profile),
              },
              direction: direction ?? "both",
              max_hops: max_hops ?? 2,
              max_frontier_entities: 50,
              max_paths: top_k ?? 25,
              explain: false,
            } as never);
          }
          return target.graphSearch(
            searchBody({
              query: q,
              mode,
              top_k,
              profile,
              as_of,
              as_of_commit_seq,
            }) as never,
          );
        },
        (data) => ({
          feedback: searchFeedbackHint(data, { query, queries, graph, branch }),
        }),
      ),
  );

  server.registerTool(
    "lbb_ask",
    {
      description:
        "Ask a natural-language question about the graph and get a grounded answer with citations. The database snaps the question to its real vocabulary (never invented), retrieves against the pinned snapshot, and answers. `mode` is `resident_planner` when a small resident model synthesized the prose, or `grounding_only` when it returns the grounded evidence for your own model to finish. Prefer this over lbb_search when you want a direct, cited answer rather than a ranked list; set `execute: false` to get only the grounding — the real vocabulary the question maps to — without retrieval. The response `explain` block reports how much the database narrowed (vocabulary candidates the question snapped to, plus retrieved entity/assertion counts) and the per-stage latency (ground / retrieve / synth / total ms), so you can see the pipeline that produced the answer.",
      inputSchema: {
        question: z
          .string()
          .describe("The natural-language question to answer from the graph"),
        top_k: z
          .number()
          .int()
          .positive()
          .max(25)
          .optional()
          .describe("Max citations to return (default 8)"),
        execute: z
          .boolean()
          .optional()
          .describe(
            "Run retrieval and answer (default true); false returns only the grounding",
          ),
        as_of: z
          .string()
          .optional()
          .describe(
            "Valid-time cursor (RFC 3339): retrieval reflects facts true at this instant",
          ),
        as_of_commit_seq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Snapshot pin: retrieval and citations reproduce the graph as of this commit sequence",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    ({
      question,
      top_k,
      execute,
      as_of,
      as_of_commit_seq,
      detail,
      graph,
      branch,
    }) =>
      run(client, "lbb_ask", detail, () =>
        scoped(client, graph, branch).ask({
          question,
          top_k,
          execute,
          ...(as_of !== undefined ? { as_of_valid_time: as_of } : {}),
          ...(as_of_commit_seq !== undefined ? { as_of_commit_seq } : {}),
        } as never),
      ),
  );

  server.registerTool(
    "lbb_decode",
    {
      description:
        "Name the relation between two entities. The database narrows the candidates to the relations its type signatures admit for the (source type, target type) pair; if the pair admits exactly one, the database answers alone (`mode: forced`, no model call). Otherwise a small model fine-tuned on this graph's own edges picks from the narrowed set (`mode: model_narrowed`), constrained to real vocabulary so it can only emit a relation that can exist. You can OMIT the types — pass just the names and the database recovers each type by resolving the name to a real entity (echoed in `resolved_source`/`resolved_target`). Use it to fill a missing edge label, verify a relationship, or assemble structured triples. Returns the `relation`, the admissible `candidates`, and `signature_forced`.",
      inputSchema: {
        source_name: z.string().describe("Source entity display name"),
        source_type: z
          .string()
          .optional()
          .describe(
            "Source entity type; omit to have the DB recover it from the name",
          ),
        target_name: z.string().describe("Target entity display name"),
        target_type: z
          .string()
          .optional()
          .describe(
            "Target entity type; omit to have the DB recover it from the name",
          ),
        use_model_when_forced: z
          .boolean()
          .optional()
          .describe(
            "Call the model even when the type pair forces one relation (default false — a forced pair is answered by the DB alone)",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    ({
      source_name,
      source_type,
      target_name,
      target_type,
      use_model_when_forced,
      detail,
      graph,
      branch,
    }) =>
      run(client, "lbb_decode", detail, () =>
        scoped(client, graph, branch).decode({
          source: { name: source_name, type: source_type },
          target: { name: target_name, type: target_type },
          use_model_when_forced,
        } as never),
      ),
  );

  server.registerTool(
    "lbb_ground",
    {
      description:
        "Ground your terms to the graph's real vocabulary before you query or write, so you never guess a type, relation, or property name. Actions: `complete` — narrowed autocomplete: completes a prefix against the real vocabulary, optionally narrowed to the relations a (src_type, dst_type) pair actually admits (so you only propose relations that can exist); `resolve` — snap free text to the single nearest real vocabulary item by embedding/lexical similarity, never fabricating a name; `audit` — groundability report: signature sparsity, name semantics, sampled narrowing recall, and a narrow / narrow+finetune / lexical recommendation for this graph.",
      inputSchema: {
        action: z
          .enum(["complete", "resolve", "audit"])
          .describe(
            "complete = narrowed vocabulary autocomplete; resolve = snap free text to the nearest real vocabulary; audit = groundability report",
          ),
        prefix: z
          .string()
          .optional()
          .describe(
            "[complete] Text prefix to complete against the real vocabulary",
          ),
        text: z
          .string()
          .optional()
          .describe(
            "[resolve] Free text to snap to the nearest real vocabulary item",
          ),
        src_type: z
          .string()
          .optional()
          .describe(
            "[complete] Narrow relation completions to those admitted FROM this source type",
          ),
        dst_type: z
          .string()
          .optional()
          .describe(
            "[complete] Narrow relation completions to those admitted INTO this target type",
          ),
        kinds: z
          .array(
            z.enum([
              "term",
              "attribute_value",
              "attribute_field",
              "class",
              "relation",
              "property",
            ]),
          )
          .optional()
          .describe(
            "[complete/resolve] Restrict to these vocabulary kinds (default: all)",
          ),
        top_k: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("[complete/resolve] Max results (default 8)"),
        sample: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("[audit] Entities to sample for narrowing-recall"),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    ({
      action,
      prefix,
      text,
      src_type,
      dst_type,
      kinds,
      top_k,
      sample,
      detail,
      graph,
      branch,
    }) =>
      run(client, "lbb_ground", detail, () => {
        const target = scoped(client, graph, branch);
        if (action === "resolve") {
          return target.resolveTerm({
            text: requireString(text, "text"),
            kinds: (kinds ?? ["class", "relation", "property"]) as never,
            top_k,
          } as never);
        }
        if (action === "audit") {
          return target.groundability(sample != null ? { sample } : {});
        }
        const context =
          src_type !== undefined || dst_type !== undefined
            ? { src_type, dst_type }
            : undefined;
        return target.suggest({
          prefix: requireString(prefix, "prefix"),
          kinds: kinds as never,
          context,
          limit: top_k,
        } as never);
      }),
  );

  server.registerTool(
    "lbb_inspect",
    {
      description:
        "Read graph context and exact graph facts. Actions: guide, ontology, ontology_conformance, schema, schema_preview, schema_audit, rules, ontology_search, metadata, entity, edges, state, history, transitions, why, traverse. entity returns one node's metadata, scalar attributes, current state, edges, history, and observations — its edge/history arrays are a display sample capped at the detail limit (counts holds the true totals), so on a high-degree node the response carries an `edge_sample` block with the capped totals and ready-to-run paged reads; follow those (or call edges/history directly, paged by row_limit/offset with direction/relation filters and an as_of/as_of_commit_seq pin) to read the full set — total_count tells you when to stop. transitions returns the ordered state-transition log of an entity's relation with dwell time at each value (cycle-time/process analysis). metadata includes temporal_coverage — check it before attempting as-of/daily views: as_of_valid_time_degenerate or single_commit_time means every point-in-time query returns the same snapshot. Use ontology_conformance to check the live data against the ontology's own capped-cardinality rules (derived SHACL sh:maxCount, whole-snapshot, never blocks a write) — distinct from schema_audit, which runs the separately-published SHACL shape bundle.",
      inputSchema: inspectWireSchema,
      annotations: READ_ONLY,
    },
    (rawArgs) => {
      const parsed = inspectInputSchema.safeParse(rawArgs);
      if (!parsed.success) return errorResult(parsed.error);
      const args = parsed.data;
      return run(
        client,
        `lbb_inspect.${args.action}`,
        args.detail,
        () => {
          const target = scoped(client, args.graph, args.branch);
          switch (args.action) {
            case "guide":
              return guide(target);
            case "ontology":
              // Request per-relation edge counts so the listing flags which of the
              // declared relations are actually populated (edge_count: 0 = unused).
              return target.ontologyView({ counts: true });
            case "ontology_conformance":
              return target.ontologyConformance();
            case "schema":
              return target.schema.view();
            case "schema_preview":
              return schemaPreview(target, {
                graph: args.graph,
                branch: args.branch,
                ontology: args.ontology,
                shapes: args.shapes,
                base_ontology_version: args.base_ontology_version,
                base_shapes_version: args.base_shapes_version,
                desired_mode: args.desired_mode,
              });
            case "schema_audit":
              return target.schema.audit();
            case "rules":
              return target.graphRules();
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
            case "edges":
              // Paged edge listing — the way to read every edge of a high-degree
              // node, which `entity` hard-caps. Returns the unified list envelope;
              // page by feeding next_cursor back as `cursor` until has_more=false.
              return target.graphEdges({
                id: args.entity_id,
                type: args.entity_type,
                name: args.name,
                direction: args.direction,
                relation: args.relation,
                limit: args.row_limit,
                cursor: args.cursor,
                offset: args.offset,
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
            case "traverse":
              return target.traverse({
                start: {
                  entity_type: args.entity_type,
                  name: args.name,
                },
                relations: args.relations ?? null,
                direction: args.direction ?? "both",
                max_hops: args.max_hops ?? 2,
                max_frontier_entities: 50,
                max_paths: args.top_k ?? 25,
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
        },
        (data) =>
          args.action === "entity"
            ? entityEdgeCapHint(
                data,
                args.detail,
                args.entity_id
                  ? { entity_id: args.entity_id }
                  : { entity_type: args.entity_type, name: args.name },
              )
            : {},
      );
    },
  );

  server.registerTool(
    "lbb_query",
    {
      description:
        "Analytical and expert reads. Modes: structured (SPARQL-subset JSON body), sparql (SPARQL text), shacl, infer, retrieval_premises, analyze. Relations are <https://littlebigbrain.com/r/NAME> and types <https://littlebigbrain.com/class/NAME> (both lowercased); entities are content-addressed, so anchor a named one by its rdfs:label rather than building its IRI (see the sparql/structured field hints, and lbb_inspect action=ontology for exact names). For structured/sparql row paging, MCP owns limit/offset via row_limit/cursor; a cursor reuses the original query/body and pins continuation pages to the original head commit. When a single page's rows are complete server-side (row_page.has_more false) but too large for one MCP result, the envelope reports `rows_shown` (fewer than row_page.returned), keeps `truncated: true`, and hands back a `next` cursor that pages the same result set at a smaller row_limit — so a large fully-returned result is never silently cut without a way to read the rest.",
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
              // The body's valid-time field is `as_of_valid_time`; the server
              // ignores a bare `as_of` key, so a naive caller would chart
              // head-snapshot data and never know. Turn that silent no-op into a
              // clear error pointing at the right spelling.
              if (body.as_of !== undefined) {
                throw new Error(
                  "the structured body has an `as_of` key, which the server ignores — use the top-level `as_of` argument (valid-time, RFC3339) or rename it to `as_of_valid_time` inside the body",
                );
              }
              if (
                cursor &&
                args.as_of !== undefined &&
                args.as_of !== cursor.as_of
              ) {
                throw new Error(
                  "cursor as_of does not match the supplied as_of argument",
                );
              }
              // Commit-seq pin: top-level arg, else the body field, pinned for
              // continuation. Valid-time pin: cursor, else top-level arg, else the
              // body's `as_of_valid_time`. Both are resolved here and set
              // explicitly so the request never depends on the body's spelling.
              const requestedCommitSeq =
                args.as_of_commit_seq ??
                (typeof body.as_of_commit_seq === "number"
                  ? body.as_of_commit_seq
                  : undefined);
              const asOfCommitSeq = await queryCommitPin(
                target,
                requestedCommitSeq,
                cursor,
              );
              const asOfValidTime =
                cursor?.as_of ??
                args.as_of ??
                (typeof body.as_of_valid_time === "string"
                  ? body.as_of_valid_time
                  : undefined);
              const request: Record<string, unknown> = {
                ...body,
                limit: rowLimit,
                offset,
                as_of_commit_seq: asOfCommitSeq,
                as_of_valid_time: asOfValidTime ?? null,
              };
              const combinators = request.combinators;
              const hasCombinators =
                Array.isArray(combinators) && combinators.length > 0;
              // HAVING runs on the SPARQL-select path; the combinator/analytics
              // path does not evaluate it. Routing a having+combinators body to
              // analytics would silently drop the filter, so reject it loudly
              // instead (the schema/runtime mismatch the feedback hit).
              const hasHaving =
                Array.isArray(request.having) && request.having.length > 0;
              if (hasCombinators && hasHaving) {
                throw new Error(
                  "HAVING is not evaluated alongside UNION/OPTIONAL/MINUS combinators — remove the combinators to use HAVING (grouped aggregation), or apply the threshold client-side.",
                );
              }
              const response = hasCombinators
                ? await target.analytics(request as never)
                : await target.sparql(request as never);
              const rowPage = rowPageFrom(response);
              const cursorBase: Omit<QueryCursor, "offset"> = {
                v: 1,
                mode: "structured",
                graph,
                branch,
                detail,
                row_limit: rowLimit,
                body,
                as_of: asOfValidTime,
                as_of_commit_seq: asOfCommitSeq,
              };
              const next = rowPageNext(cursorBase, rowPage);
              return toolResult(
                queryEnvelope(
                  `lbb_query.${args.mode}`,
                  response,
                  detail,
                  rowPage,
                  next,
                  cursorBase,
                ),
              );
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
            if (
              cursor &&
              args.as_of !== undefined &&
              args.as_of !== cursor.as_of
            ) {
              throw new Error(
                "cursor as_of does not match the supplied as_of argument",
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
            const asOf = cursor?.as_of ?? args.as_of;
            const asOfCommitSeq = await queryCommitPin(
              target,
              args.as_of_commit_seq,
              cursor,
            );
            const response = await target.sparqlText({
              query,
              as_of_valid_time: asOf ?? null,
              as_of_commit_seq: asOfCommitSeq ?? null,
              limit: rowLimit,
              offset,
            } as never);
            const data = JSON.parse((response as { results: string }).results);
            const rowPage = rowPageFrom(response);
            const cursorBase: Omit<QueryCursor, "offset"> = {
              v: 1,
              mode: "sparql",
              graph,
              branch,
              detail,
              row_limit: rowLimit,
              query,
              as_of: asOf,
              as_of_commit_seq: asOfCommitSeq,
            };
            const next = rowPageNext(cursorBase, rowPage);
            const sparqlEnvelope = queryEnvelope(
              `lbb_query.${args.mode}`,
              data,
              detail,
              rowPage,
              next,
              cursorBase,
            );
            return toolResult(
              notes.length > 0 ? { ...sparqlEnvelope, notes } : sparqlEnvelope,
            );
          } catch (error) {
            return errorResult(await enrichError(client, error));
          }
        })();
      }
      return run(client, `lbb_query.${args.mode}`, args.detail, async () => {
        const target = scoped(client, args.graph, args.branch);
        switch (args.mode) {
          case "shacl":
            return target.shacl({
              shapes: args.shapes ?? [],
              mode: args.shacl_mode ?? "select",
              include_derived: args.include_derived ?? false,
              rules: args.rules ?? [],
              as_of_valid_time: args.as_of ?? null,
              top_k: args.top_k ?? 10,
              explain: args.explain ?? false,
            } as never);
          case "infer":
            return target.infer({
              rules: args.rules ?? [],
              max_rounds: args.max_rounds ?? null,
              max_derived: args.max_derived ?? null,
              max_solutions: args.max_solutions ?? null,
              as_of_valid_time: args.as_of ?? null,
              as_of_commit_seq: args.as_of_commit_seq ?? null,
            } as never);
          case "retrieval_premises":
            return target.retrievalPremises({
              anchor: {
                entity_type: args.anchor_type,
                name: args.anchor_name,
              },
              relation: args.relation,
              model_id: "lbb-hash-lexical-v1",
              target_kind: "entity",
              calibration: { a: -1, b: 0 },
              threshold: args.threshold ?? 0.5,
              max_premises: args.max_premises ?? 50,
              query: args.query,
              query_top_k: args.query_top_k ?? 50,
            } as never);
          case "analyze":
            return analyze(target, {
              metric: args.metric,
              chart: args.chart,
              top_k: args.top_k,
              query: args.query,
              field: args.field,
              sparql: args.sparql,
            });
        }
      });
    },
  );

  server.registerTool(
    "lbb_commit",
    {
      description:
        "Write graph facts, retract them, or label search results. mode=facts writes triplets/embeddings/properties; mode=retract removes a wrongly-added fact (by edge or by entity) without a full reset; mode=search_feedback labels query/result relevance after lbb_search (Feedback grades: 3=ideal/good, 1=partial, 0=bad; include query, search_id when available, target, rank, score). Explicit idempotency_key wins; when omitted, MCP derives a stable content hash so content-identical retries dedupe. Facts mode defaults edge_idempotency to append; pass skip_unchanged for re-runnable backfills.",
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
        return scoped(client, graph, branch).commit(payload as never, {
          idempotencyKey: key,
        });
      }),
  );

  server.registerTool(
    "lbb_configure",
    {
      description:
        "Mutate stored graph configuration. Actions: define_ontology (create a new graph ontology), evolve_ontology (evolve an existing graph's ontology in place by name — add_entity_type / add_relation / add_property (a typed scalar field so entity_properties can write it) / widen_relation, rename and set-inverse/cardinality, and data-gated narrow/remove; bumps the ontology version, preserves every record, no migration), publish_schema (activate a previewed RDF/SHACL shape bundle), and define_rules (replace the branch's stored inference rules — body/head terms may be variables or fixed entities, and not_exists combinators add stratified negation for universal conditions).",
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
              }) as never,
            );
        }
        if (args.action === "evolve_ontology") {
          return scoped(client, args.graph, args.branch).evolveOntology({
            ops: args.ops,
            allow_data_conflicts: args.allow_data_conflicts ?? false,
          } as never);
        }
        if (args.action === "publish_schema") {
          return scoped(client, args.graph, args.branch).schema.publish(
            schemaPublishBody({
              preview_digest: args.preview_digest,
              ontology: args.ontology,
              shapes: args.shapes,
              desired_mode: args.desired_mode,
              confirm_restrictive: args.confirm_restrictive,
            }) as never,
          );
        }
        if (args.rules.length === 0 && args.confirm_empty !== true) {
          throw new Error(
            "define_rules with an empty rules array requires confirm_empty=true",
          );
        }
        return scoped(client, args.graph, args.branch).defineRules({
          rules: args.rules,
        } as never);
      });
    },
  );

  server.registerTool(
    "lbb_index",
    {
      description:
        "Build or refresh persisted BM25, vector, and adjacency indexes so recently committed facts become searchable.",
      inputSchema: {
        background: z
          .boolean()
          .optional()
          .describe("Run detached and poll metadata for completion"),
        ...graphScope,
      },
      annotations: MUTATING,
    },
    ({ background, graph, branch }) =>
      run(client, "lbb_index", "standard", () =>
        scoped(client, graph, branch).indexRun({ background }),
      ),
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
