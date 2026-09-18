import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LbbClient } from "@littlebigbrain/client";
import { z } from "zod";
import { metadataPage } from "./metadata-pages.js";
import { registerRdfTool } from "./rdf-tool.js";
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
  enrichError,
  errorResult,
  guide,
  normalizeDetail,
  normalizeLbbIris,
  ontologyDefineBody,
  queryCommitPin,
  queryEnvelope,
  requireString,
  rowPageFrom,
  rowPageNext,
  run,
  scoped,
  stableJson,
  toolResult,
} from "./tool-runtime.js";

export function registerLbbTools(server: McpServer, client: LbbClient): void {
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
        "Analytical and expert reads. Modes: structured (SPARQL-subset JSON body), sparql (SPARQL text), analyze. SPARQL is the only query surface. Relations are <https://littlebigbrain.com/r/NAME> and types <https://littlebigbrain.com/class/NAME> (both lowercased); entities are content-addressed, so anchor a named one by its rdfs:label rather than building its IRI. Structured and text queries pin one published watermark for the request.",
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
              const asOfCommitSeq = await queryCommitPin(
                target,
                requestedCommitSeq,
                cursor,
              );
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
              const response = await target.sparql(request as never, {
                consistency,
                minIndexedSeq,
              });
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
            const asOfCommitSeq = await queryCommitPin(
              target,
              args.as_of_commit_seq,
              cursor,
            );
            const entailment = cursor?.entailment ?? args.entailment ?? "none";
            const response = await target.sparqlText(
              {
                query,
                entailment,
                as_of_commit_seq: asOfCommitSeq ?? null,
                limit: rowLimit,
                offset,
              },
              { consistency, minIndexedSeq },
            );
            const data = JSON.parse(response.results);
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
