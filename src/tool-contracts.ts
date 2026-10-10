import type { Schemas } from "@littlebigbrain/client";
import { z } from "zod";

export type Detail = "compact" | "standard" | "full";
export type NamedCount = { name: string; count: number };
export type ChartPoint = { label: string; value: number };
export type RowPage = Schemas["RowPage"];
export type GraphMetadataResponse = Schemas["GraphMetadataResponse"];
export type QueryCursor = {
  v: 1;
  mode: "sparql" | "structured";
  graph?: string;
  detail: Detail;
  row_limit: number;
  offset: number;
  query?: string;
  body?: Record<string, unknown>;
  as_of?: string;
  as_of_commit_seq?: number;
  entailment?: "none" | "subclass" | "rdfs" | "owl";
  consistency?: "eventual" | "strong";
  min_indexed_seq?: number;
};

export const DEFAULT_DETAIL: Detail = "compact";
export const HARD_OUTPUT_CHARS = 80_000;
export const MAX_QUERY_ROW_LIMIT = 5_000;
/** The most rows each query of `POST /v1/query/ask` returns. */
export const QUESTION_MAX_ROWS = 1_000;
/** Entity IRIs one question may anchor, and the characters of one. */
export const QUESTION_MAX_ANCHORS = 10;
export const QUESTION_MAX_ANCHOR_CHARS = 2_000;
/** Dated points one question's timeline may carry, and the characters of a label. */
export const QUESTION_MAX_TIMELINE = 200;
export const QUESTION_MAX_TIMELINE_LABEL_CHARS = 200;
export const READ_ONLY = { readOnlyHint: true } as const;
export const IDEMPOTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const detailSchema = z
  .enum(["compact", "standard", "full"])
  .optional()
  .describe("Response detail level. Defaults to compact.");
export const rowLimitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_QUERY_ROW_LIMIT)
  .optional()
  .describe(
    "Maximum query rows to return in this page. Defaults by detail: compact=20, standard=100, full=1000.",
  );
export const cursorSchema = z
  .string()
  .optional()
  .describe(
    "Opaque cursor from a previous lbb_query row page; reruns the original query at the next offset.",
  );

export const graphScope = {
  graph: z
    .string()
    .optional()
    .describe("Graph to target; defaults to the connection's graph"),
};

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonObjectArraySchema = z.array(jsonObjectSchema);
/** A month, `yyyy-mm` (UTC), as the model activity and model checks read it. */
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const readScope = { detail: detailSchema, ...graphScope };
export const metadataPageSchema = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Maximum complete metadata entries per page; defaults to 50. Nested fields are never truncated; an oversized single entry returns serialized_json fragments to concatenate and parse.",
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque lbb_inspect continuation. Repeat action and pass the returned next arguments; rejects changed metadata.",
    ),
  section: z
    .string()
    .optional()
    .describe(
      "Optional top-level array to inspect, e.g. entity_type_defs, relation_defs, property_defs, classes, or relations. Omit to page through all sections.",
    ),
};
const queryConsistencySchema = {
  consistency: z
    .enum(["eventual", "strong"])
    .optional()
    .describe(
      "Read consistency. strong requires publication through head; a pending response is retryable.",
    ),
  min_indexed_seq: z
    .number()
    .int()
    .nonnegative()
    .safe()
    .optional()
    .describe(
      "Read-after-write publication floor. Preserved across cursor pages.",
    ),
};

export const entitySelectorSchema = z
  .object({
    entity_type: z
      .string()
      .optional()
      .describe("Entity type name (with `name`, names a fixed entity)"),
    name: z
      .string()
      .optional()
      .describe("Entity name (paired with `entity_type`)"),
    entity_id: z
      .string()
      .optional()
      .describe("Entity id (hex), as an alternative to type+name"),
  })
  .passthrough();
export const searchFeedbackTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("entity"),
      entity: entitySelectorSchema,
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("assertion"),
      edge_event_id: z.string(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("observation"),
      observation_id: z.string(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("concept"),
      concept_id: z.string().optional(),
      name: z.string().optional(),
    })
    .passthrough(),
]);
export const searchFeedbackSchema = z
  .object({
    query: z.string().min(1),
    search_id: z.string().optional(),
    snapshot: z.record(z.string(), z.unknown()).optional(),
    profile: z.string().optional(),
    model_id: z.string().optional(),
    labeler_id: z.string().optional(),
    labels: z
      .array(
        z
          .object({
            target: searchFeedbackTargetSchema,
            rank: z.number().int().positive().optional(),
            score: z.number().optional(),
            grade: z.number().int().min(0).max(3),
            reason: z.string().optional(),
            split: z.enum(["train", "eval", "unspecified"]).optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
export const ontologyFormatSchema = z.enum([
  "auto",
  "turtle",
  "json_ld",
  "rdf_xml",
  "csv",
  "tsv",
  "lbb_json",
  "spec",
]);
export const shapeFormatSchema = z.enum([
  "auto",
  "turtle",
  "n_triples",
  "n_quads",
  "trig",
]);
export const ontologySourceSchema = z
  .object({
    source: z.string().describe("Ontology source text"),
    format: ontologyFormatSchema.optional(),
  })
  .strict();
export const shapeSourceSchema = z
  .object({
    source: z.string().describe("SHACL/RDF shape source text"),
    format: shapeFormatSchema.optional(),
  })
  .strict();
export const schemaModeSchema = z.enum(["off", "warn", "reject"]);
export const ontologyEvolveOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add_super_types"),
      entity_type: z.string(),
      super_types: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("widen_relation"),
      relation: z
        .string()
        .describe("Relation to widen, by name (case-insensitive)"),
      add_domain: z
        .array(z.string())
        .optional()
        .describe(
          "Entity-type names to add to the relation's domain (source types)",
        ),
      add_range: z
        .array(z.string())
        .optional()
        .describe(
          "Entity-type names to add to the relation's range (target types)",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("add_entity_type"),
      name: z
        .string()
        .describe(
          "Display name of the new entity type (idempotent if it exists)",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("add_relation"),
      name: z
        .string()
        .describe("Display name of the new relation, e.g. HAS_PHASE"),
      domain: z
        .array(z.string())
        .optional()
        .describe(
          "Entity-type names allowed as the source (domain); must already exist",
        ),
      range: z
        .array(z.string())
        .optional()
        .describe(
          "Entity-type names allowed as the target (range); must already exist",
        ),
      cardinality: z
        .enum(["one_to_one", "one_to_many", "many_to_one", "many_to_many"])
        .optional()
        .describe("Defaults to many_to_many"),
      temporal_semantics: z
        .enum(["atemporal", "valid_time", "commit_time", "bitemporal"])
        .optional()
        .describe("Defaults to bitemporal"),
      reducer: z
        .string()
        .optional()
        .describe(
          "State-reducer token, e.g. append_only (default), latest_wins",
        ),
      inverse_name: z
        .string()
        .optional()
        .describe(
          "Optional inverse-relation display name, e.g. PHASE_OF (enables one-hop reverse traversal)",
        ),
      transitive: z.boolean().optional(),
      symmetric: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("add_property"),
      name: z
        .string()
        .describe(
          "Display name of the new scalar property field, e.g. status (idempotent if it exists)",
        ),
      value_type: z
        .enum(["bool", "i64", "f64", "date_time", "keyword", "text", "bytes"])
        .optional()
        .describe(
          "Scalar type; defaults to text. Lets a later lbb_commit set entity_properties[].field",
        ),
      required: z
        .boolean()
        .optional()
        .describe("Advisory required flag (not enforced on commit)"),
    })
    .strict(),
  z
    .object({
      op: z.literal("rename_entity_type"),
      from: z.string().describe("Current entity-type name"),
      to: z
        .string()
        .describe(
          "New display name (stable id stays frozen; records keep resolving)",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("rename_relation"),
      from: z.string().describe("Current relation name"),
      to: z
        .string()
        .describe(
          "New display name (stable id stays frozen; edges keep resolving)",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_relation_inverse"),
      relation: z.string().describe("Relation to set the inverse on, by name"),
      inverse_name: z
        .string()
        .describe(
          "Inverse-relation display name, e.g. PHASE_OF (enables one-hop reverse traversal)",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_relation_cardinality"),
      relation: z.string().describe("Relation to change, by name"),
      cardinality: z.enum([
        "one_to_one",
        "one_to_many",
        "many_to_one",
        "many_to_many",
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("narrow_relation"),
      relation: z.string().describe("Relation to narrow, by name"),
      remove_domain: z
        .array(z.string())
        .optional()
        .describe(
          "Entity-type names to remove from the relation's domain (subtractive)",
        ),
      remove_range: z
        .array(z.string())
        .optional()
        .describe(
          "Entity-type names to remove from the relation's range (subtractive)",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("remove_entity_type"),
      name: z
        .string()
        .describe(
          "Entity type to tombstone — kept readable for old records, rejected for new commits",
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal("remove_relation"),
      name: z
        .string()
        .describe(
          "Relation to tombstone — old edges stay readable, rejected for new commits",
        ),
    })
    .strict(),
]);

const namedEntityInputSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    key: z
      .string()
      .optional()
      .describe("The record's external key, when it has one"),
  })
  .strict();

/** Graph facts a review item proposes; accepting commits them. */
export const suggestedFactsSchema = z
  .object({
    triplets: z
      .array(
        z
          .object({
            source: namedEntityInputSchema,
            relation: z.string(),
            target: namedEntityInputSchema,
            confidence: z.number().min(0).max(1).optional(),
            evidence: z
              .unknown()
              .optional()
              .describe(
                "Why the link holds: a string, or { text, source_id } as lbb_commit takes it",
              ),
          })
          .passthrough(),
      )
      .max(200)
      .optional()
      .describe("Links to commit, as lbb_commit takes triplets"),
    entity_properties: z
      .array(jsonObjectSchema)
      .max(200)
      .optional()
      .describe(
        "Fields to commit, each { type, name, properties: { field: value } } as lbb_commit takes them",
      ),
    replace_owned: z
      .object({
        subjects: z
          .array(namedEntityInputSchema)
          .max(1000)
          .describe("The records this write is for"),
        relations: z
          .array(z.string())
          .max(64)
          .optional()
          .describe(
            "Owned relations: their current out-edges of the subjects that the facts do not write again are removed",
          ),
        properties: z
          .array(z.string())
          .max(64)
          .optional()
          .describe(
            "Owned fields: the ones the facts do not set on a subject are removed",
          ),
        retract_entities: z
          .array(namedEntityInputSchema)
          .max(1000)
          .optional()
          .describe("Records the producer made and no longer makes"),
      })
      .strict()
      .optional()
      .describe(
        "Replace the producer's owned edges and fields on its subjects in the same commit",
      ),
    summary: z
      .string()
      .max(500)
      .optional()
      .describe("One line about the facts for the reviewer"),
  })
  .strict()
  .describe(
    "Graph facts a person confirms: accepting commits them after the change (at most 200 triplets and property rows together). Records graphs only",
  );

export const inspectInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("guide"), ...readScope }).strict(),
  z
    .object({
      action: z.literal("ontology"),
      ...metadataPageSchema,
      ...readScope,
    })
    .strict(),
  z
    .object({ action: z.literal("ontology_conformance"), ...readScope })
    .strict(),
  z
    .object({
      action: z.literal("schema"),
      ...metadataPageSchema,
      ...readScope,
    })
    .strict(),
  z.object({ action: z.literal("graphs"), ...readScope }).strict(),
  z.object({ action: z.literal("publication"), ...readScope }).strict(),
  z
    .object({
      action: z.literal("ontology_search"),
      query: z
        .string()
        .describe("Ontology concept, term, or relation to search"),
      top_k: z.number().int().positive().optional(),
      ...readScope,
    })
    .strict(),
  z.object({ action: z.literal("metadata"), ...readScope }).strict(),
  z
    .object({
      action: z.literal("ontology_suggestions"),
      status: z
        .enum(["open", "accepted", "dismissed", "superseded"])
        .optional()
        .describe("Only suggestions in this state; default all"),
      limit: z.number().int().min(1).max(500).optional(),
      ...readScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("entity"),
      entity_id: z
        .string()
        .optional()
        .describe("Entity id (hex); alternative to entity_type+name"),
      entity_type: z.string().optional(),
      name: z.string().optional(),
      // Kept for an actionable error when an older connector sends this field.
      as_of: z
        .string()
        .optional()
        .describe(
          "Unsupported for entity; use as_of_commit_seq for a retained commit snapshot.",
        ),
      as_of_commit_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Snapshot pin: reproduce the node's attributes and relationships as of this commit_seq.",
        ),
      ...readScope,
    })
    .strict(),
]);

// The graph's RDF projection uses a fixed IRI scheme; teaching it here lets an
// agent write a valid query on the first attempt instead of round-tripping
// through the ontology to reverse-engineer term IRIs.
export const SPARQL_IRI_GUIDE =
  'IRI scheme: relations are <https://littlebigbrain.com/r/NAME> (NAME lowercased, e.g. writes_to; reverse a relation with the ^ path operator, no stored inverse triple). Types are <https://littlebigbrain.com/class/NAME> (lowercased), matched as `?x a <…/class/NAME>` with explicit entailment=subclass, rdfs, or owl for inference (default none). Property fields are <https://littlebigbrain.com/p/NAME> (lowercased). The local name is ALWAYS lowercase — an uppercase one (e.g. <…/r/FOR_CLIENT>) is a different, non-existent IRI that silently matches nothing; this tool auto-lowercases the local name of /r/, /class/, and /p/ IRIs for you and adds a `notes` entry when it does, so a stray uppercase still resolves. (Structured mode\'s `predicate` is case-insensitive on its own.) Entities are content-addressed <https://littlebigbrain.com/e/HASH> — never build an entity IRI from a name; anchor a named entity by its label instead: `?e <http://www.w3.org/2000/01/rdf-schema#label> "Acme"`. Discover the exact relation and type names with lbb_inspect action=ontology. SELECT and ASK only (CONSTRUCT/DESCRIBE are rejected).';

// Search by meaning runs inside SPARQL text as a pattern, so an agent can
// filter and join the hits in one query instead of a search then a lookup.
export const SPARQL_SEARCH_GUIDE =
  'Search by meaning inside the query (the graph needs an embedding; see lbb_embeddings action=list): PREFIX search: <https://littlebigbrain.com/search#> SELECT ?x ?score WHERE { ?x search:similarTo "card payments" ; search:score ?score . ?x <https://littlebigbrain.com/r/calls> ?y } ORDER BY DESC(?score) LIMIT 5. The other patterns filter and join the hits. One search:similarTo per query, with a variable subject, in the main group (not inside OPTIONAL, UNION, MINUS or a subquery). The object is text, an entity IRI (records like that one) or a vector literal. search:top N sets the hits (1 to 1000; default the query LIMIT, then 10) and search:embedding "name" searches one embedding. FILTER(?score > 0.8) keeps close hits. The result\'s search field reports the plan (nearest, filter_first or search_first), the hits and complete. For a question in words, add search:rerank true ; search:relevance ?r and ORDER BY DESC(?r): the rerank model (Jev) reads the best hits with the text, keeps the top that answer it and binds its answer (0 to 1); search.rerank reports the status. Only a text query reranks.';

/** One point of `lbb_query mode=compare`: a commit, a date or a moment. */
const comparePointSchema = z
  .object({
    as_of_commit_seq: z.number().int().min(0).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    moment: z.string().optional(),
  })
  .strict();

export const queryInputSchema: z.ZodDiscriminatedUnion<
  "mode",
  z.AnyZodObject[]
> = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("structured"),
      ...queryConsistencySchema,
      body: jsonObjectSchema
        .optional()
        .describe(
          'Structured SPARQL-subset request body. Shape: { patterns: [{ subject, predicate, object }], filters?, group_by?, group_keys?, aggregates?, having?, order_by?, select?, limit?, distinct? }. Each pattern term is { var: "x" } or a fixed { entity: { entity_type, name } }; `predicate` is a relation name and is case-insensitive here (FOR_CLIENT and for_client both resolve — unlike SPARQL text, which needs the lowercased IRI local name). ' +
            "FILTER — `filters` is a list of conditions, each of exact shape " +
            '{ "compare": { "op": <op>, "left": <term>, "right": <term> } } (or { "and": [<filter>…] }, { "or": [<filter>…] }, { "not": <filter> }). ' +
            "`op` is one of eq | ne | lt | le | gt | ge (NOT the symbols =,<,>). Each <term> is exactly one of " +
            '{ "var": "x" }, { "property": { "var": "x", "field": "amount" } } (a typed scalar attribute), or ' +
            '{ "value": <typed> } — and <typed> is exactly one wrapper: { "str": "…" }, { "i64": 5 }, { "f64": 0.9 }, { "bool": true }, { "date_time": "2026-01-01" } (RFC3339), or { "entity": { "entity_type": "T", "name": "N" } }. ' +
            'Complete runnable example — deals whose amount ≥ 1000000: { "patterns": [{ "subject": { "var": "d" }, "predicate": "for_client", "object": { "var": "c" } }], "filters": [{ "compare": { "op": "ge", "left": { "property": { "var": "d", "field": "amount" } }, "right": { "value": { "f64": 1000000 } } } }] }. ' +
            "Comparisons use the field's real declared type (numbers as numbers, datetimes as instants), so they run server-side. " +
            'GROUP BY supports both entity-identity keys (group_by: ["s"]) and typed scalar keys via group_keys: a property value ({ property: { var, field, as } }) or a calendar bucket of a datetime property ({ date_bucket: { var, field, granularity: year|month|week|day|hour, as } }). Scalar keys come back per group under value_keys[as] — so a per-area breakdown or a commits-per-month time series is one server-side query, no client-side bucketing. Worked example -- commits per area per month in one query: { "patterns": [{ "subject": { "var": "c" }, "predicate": "committed_to", "object": { "var": "repo" } }], "group_keys": [{ "date_bucket": { "var": "c", "field": "committed_at", "granularity": "month", "as": "m" } }, { "property": { "var": "c", "field": "area", "as": "area" } }], "aggregates": [{ "func": "count", "as": "n" }], "order_by": [{ "var": "m" }] } -- area and committed_at are typed entity attributes (set via entity_properties; readable flat under attributes, never a nested metadata blob), and each group returns value_keys.m + value_keys.area + aggregates.n. `having: [...]` takes the same filter shape over the aggregated groups (e.g. { "compare": { "op": "gt", "left": { "var": "n" }, "right": { "value": { "i64": 10 } } } }). A `combinators` key (UNION/OPTIONAL/MINUS/EXISTS) is rejected here; express those with SPARQL text under mode=sparql. Cheap aggregate count: pair an equality having (e.g. { "compare": { "op": "eq", "left": { "var": "n" }, "right": { "value": { "i64": 4 } } } }) with row_limit: 1 -- the response row_page.total reports how many groups match without materializing them all, so you read the count off row_page.total instead of paging every matching row. For snapshot pinning use the top-level `as_of_commit_seq` argument or the same body field. Valid-time `as_of` and `as_of_valid_time` selectors are unsupported and rejected before HTTP.',
        ),
      as_of: z
        .string()
        .optional()
        .describe(
          "Unsupported in structured and SPARQL text modes; use as_of_commit_seq for a retained commit snapshot.",
        ),
      as_of_commit_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Snapshot pin: evaluate the body as of this commit_seq, hiding later commits. Errors if past head. Top-level alias for the body's `as_of_commit_seq` (either works for this one).",
        ),
      row_limit: rowLimitSchema,
      cursor: cursorSchema,
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("sparql"),
      ...queryConsistencySchema,
      entailment: z
        .enum(["none", "subclass", "rdfs", "owl"])
        .optional()
        .describe(
          "Reasoning over the pinned RDF generation. Defaults to none. owl includes RDFS, inverse relationships and the supported OWL profile.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          `SPARQL 1.1 query text (SELECT or ASK). Valid-time as_of is unsupported; use as_of_commit_seq for a retained commit snapshot. ${SPARQL_IRI_GUIDE} Example: SELECT ?service ?db WHERE { ?service <https://littlebigbrain.com/r/writes_to> ?db } LIMIT 10. ${SPARQL_SEARCH_GUIDE} compare: the SELECT to run at both points; leave out LIMIT.`,
        ),
      // Kept for an actionable error when an older connector sends this field.
      as_of: z
        .string()
        .optional()
        .describe("Unsupported in SPARQL text mode; use as_of_commit_seq."),
      as_of_commit_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Snapshot pin: run the query as of this commit_seq. Errors if past head.",
        ),
      request: z
        .string()
        .optional()
        .describe(
          "The user's own words behind this query (managed evals). When present the server records an eval trace and the result carries its trace_id; label the rows valid or not with lbb_evals action=label. Omit on continuation pages.",
        ),
      row_limit: rowLimitSchema,
      cursor: cursorSchema,
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("question"),
      question: z
        .string()
        .min(1)
        .describe(
          "question: the question in plain words (required), 1 to 4,000 characters. The server's model runs queries on this graph, reads their rows, and answers. describe: the question whose classes and properties to describe.",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "question: notes for the model, at most 8,000 characters: what the data means, units, names to prefer.",
        ),
      route: z
        .enum([
          "lookup",
          "aggregate",
          "search",
          "history",
          "schema",
          "unanswerable",
        ])
        .optional()
        .describe(
          "question: the kind of question, when you know it. Omit it and the router model picks it.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(QUESTION_MAX_ROWS)
        .optional()
        .describe(
          "question: rows each query of the server's loop returns, 1 to 1,000. Defaults by detail: compact=20, standard=100, full=1000. names: candidates per name, 1 to 10 (default 5). compare: entries of each list per page, 1 to 1,000 (defaults by detail: 20, 100, 500).",
        ),
      anchor: z
        .array(z.string().min(1).max(QUESTION_MAX_ANCHOR_CHARS))
        .max(QUESTION_MAX_ANCHORS)
        .optional()
        .describe(
          "question: entity IRIs the question is about, at most 10 (for example the record the user has open). The server reads each one, and its queries use these IRIs directly instead of matching their names.",
        ),
      timeline: z
        .array(
          z
            .object({
              date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .describe("YYYY-MM-DD."),
              as_of_commit_seq: z
                .number()
                .int()
                .min(0)
                .describe(
                  "The commit that holds the graph as it was on that date.",
                ),
              label: z
                .string()
                .max(QUESTION_MAX_TIMELINE_LABEL_CHARS)
                .optional()
                .describe("A name for the point, such as a milestone."),
            })
            .strict(),
        )
        .max(QUESTION_MAX_TIMELINE)
        .optional()
        .describe(
          "question: dated points that stand for the graph's commits, at most 200. A question about a date reads the commit of the latest point on or before it. Use it when the commits stand for other dates than the days they were written (a demo's milestones, an import of old records); without it the server reads the last commit written by the end of that day.",
        ),
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("search"),
      embedding: z
        .string()
        .optional()
        .describe(
          "One embedding by name (see lbb_embeddings action=list). Omit it to search every searchable class of the graph; each hit names its class.",
        ),
      text: z
        .string()
        .optional()
        .describe(
          "search: the query text (required); embedded with the graph's model. names: the question, or the names, to find (required).",
        ),
      top_k: z.number().int().positive().max(200).optional(),
      probe: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Clusters to read (default 4·√clusters, at least 8). More reads cost latency and find more.",
        ),
      include: z
        .array(z.enum(["text"]))
        .optional()
        .describe("text: return the embedded text of each hit."),
      filter: z
        .array(
          z
            .object({
              class: z
                .union([z.string(), z.array(z.string())])
                .optional()
                .describe(
                  "A class condition: one class IRI or a list (any of); subclasses too. One class condition per search.",
                ),
              via: z
                .string()
                .optional()
                .describe(
                  "A relationship condition: the relationship, a local name (calls), prefix:name, or <iri>.",
                ),
              to: z
                .union([z.string(), z.array(z.string())])
                .optional()
                .describe(
                  "With via: the entity, an IRI or a name (its label; a spelling slip resolves when one entity is clearly closest), or a list (any of).",
                ),
              direction: z
                .enum(["out", "in"])
                .optional()
                .describe(
                  "With via: out (default), the hit links to the entity; in, the entity links to the hit.",
                ),
            })
            .strict(),
        )
        .optional()
        .describe(
          'Conditions every hit must meet: {"class": …} or {"via": …, "to": …}. The response\'s filter shows how each condition resolved; an unknown relationship or name answers with the options.',
        ),
      explain: z
        .boolean()
        .optional()
        .describe(
          "Plan without running: the scope, the resolved filter, and the allowed count. No model call.",
        ),
      rerank: z
        .boolean()
        .optional()
        .describe(
          "true: the managed rerank model (Jev) orders the best hits by how well each answers the text, and each hit gets its relevance (0 to 1); adds about 0.3 s. false: the similarity order. Omit it to follow the graph's search setting.",
        ),
      request: z
        .string()
        .optional()
        .describe(
          "The user's own words (managed evals): records an eval trace; label it with lbb_evals action=label.",
        ),
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("analyze"),
      metric: z
        .enum(["entity_types", "relations", "overview", "sparql"])
        .optional(),
      chart: z.enum(["bar", "pie"]).optional(),
      top_k: z.number().int().positive().optional(),
      query: z.string().optional(),
      field: z.string().optional(),
      sparql: jsonObjectSchema.optional(),
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("names"),
      text: z
        .string()
        .min(1)
        .max(4_000)
        .describe("names: the question, or the names, to find (required)."),
      limit: z.number().int().min(1).max(10).optional(),
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("describe"),
      question: z.string().max(4_000).optional(),
      classes: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("describe: class IRIs to describe, at most 20."),
      properties: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe("describe: property IRIs to describe, at most 50."),
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("commit_at"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "commit_at: YYYY-MM-DD; the last commit written by the end of that day (UTC).",
        ),
      moment: z
        .string()
        .optional()
        .describe(
          "commit_at: RFC 3339, e.g. 2026-06-18T12:00:00Z; the last commit written at or before it.",
        ),
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("compare"),
      query: z
        .string()
        .min(1)
        .describe(
          "compare: the SELECT to run at both points. Leave out LIMIT: the server reads up to max_rows rows a point, page by page.",
        ),
      before: comparePointSchema.describe(
        'compare: the earlier point (required): {"as_of_commit_seq": n}, {"date": "YYYY-MM-DD"} or {"moment": "RFC 3339"}.',
      ),
      after: comparePointSchema
        .optional()
        .describe("compare: the later point; defaults to the latest commit."),
      key: z
        .array(z.string().min(1))
        .max(8)
        .optional()
        .describe(
          'compare: the variables that identify a row\'s entity, e.g. ["contact"]. With a key the rows are paired: added and removed hold the entities at one point only, changed the entities whose values differ. Without one whole rows are compared.',
        ),
      entailment: z.enum(["none", "subclass", "rdfs", "owl"]).optional(),
      max_rows: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .optional()
        .describe(
          "compare: rows to read per point, 1 to 50,000 (default 20,000). Past it the result says truncated.",
        ),
      limit: z.number().int().min(1).max(1_000).optional(),
      compare_cursor: z
        .string()
        .optional()
        .describe(
          "compare: the cursor of the page before, from next; pass it with the same arguments.",
        ),
      ...readScope,
    })
    .strict(),
]);

export const configureInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("define_ontology"),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Preview the exact definition without creating a graph or writing metadata.",
        ),
      graph: z.string().describe("Graph to create or redefine"),
      entity_types: z.array(z.union([z.string(), jsonObjectSchema])).optional(),
      relations: z.array(z.union([z.string(), jsonObjectSchema])).optional(),
      source: z.string().optional(),
      format: ontologyFormatSchema.optional(),
      merge_default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish_schema"),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Parse and check schema compatibility without activation or validation jobs. Does not audit all data.",
        ),
      ontology: ontologySourceSchema.optional(),
      shapes: shapeSourceSchema.optional(),
      desired_mode: schemaModeSchema.optional(),
      confirm_restrictive: z.boolean().optional(),
      ...graphScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("evolve_ontology"),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Preview ordered changes and current-data conflicts without writing metadata.",
        ),
      ops: z
        .array(ontologyEvolveOpSchema)
        .min(1)
        .describe(
          "Ontology changes to apply in order (additive, in-place edits, or subtractive)",
        ),
      allow_data_conflicts: z
        .boolean()
        .optional()
        .describe(
          "Deprecated compatibility flag; does not bypass conflicts. Preview subtractive changes with dry_run=true, repair the reported conflicts, then apply.",
        ),
      ...graphScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("list_starters"),
      ...graphScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("apply_starter"),
      starter: z
        .string()
        .min(1)
        .describe(
          "Starter id: crm, documents or work (list_starters names them)",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Answer the operations applying would run, and the resulting version, without writing",
        ),
      expected_ontology_version: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Refuse when the graph's ontology version differs"),
      ...graphScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("suggest_ontology_change"),
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Short imperative text, e.g. 'Add class Contractor'"),
      change: z
        .array(ontologyEvolveOpSchema)
        .max(128)
        .optional()
        .describe(
          "The ontology operations a person applies by accepting, in order (same shapes as evolve_ontology ops). Up to 128; may be empty or absent when facts is set",
        ),
      facts: suggestedFactsSchema.optional(),
      rationale: z
        .string()
        .max(4000)
        .optional()
        .describe("Why the ontology needs the change; cite what you saw"),
      anchor: z
        .object({
          kind: z.enum(["ontology", "class", "property", "relation"]),
          name: z.string().max(200).optional(),
        })
        .strict()
        .optional()
        .describe("The class, property or relation the change is about"),
      agent: z
        .string()
        .max(200)
        .optional()
        .describe("Your name as the producer, shown to reviewers"),
      key: z
        .string()
        .max(255)
        .optional()
        .describe(
          "Idempotency key ([A-Za-z0-9-_.:/]); filing again with the same key revises the suggestion",
        ),
      evidence: z
        .object({
          records: z.number().int().nonnegative().optional(),
          source_fields: z.array(z.string()).max(200).optional(),
          samples: z.array(jsonObjectSchema).max(20).optional(),
        })
        .strict()
        .optional()
        .describe(
          "What you saw: record count, fields, up to 20 sample records",
        ),
      ...graphScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("get_rewrite_profile"),
      ...graphScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("set_rewrite_profile"),
      notes: z
        .string()
        .max(8000)
        .optional()
        .describe(
          "What the data means for questions: which property holds the current state, what 'me' or 'my' means, which records to leave out. At most 8,000 characters",
        ),
      examples: z
        .array(
          z
            .object({
              question: z.string().min(1).max(1000),
              sparql: z
                .string()
                .min(1)
                .max(4000)
                .describe(
                  "A SELECT or ASK query with its PREFIX lines; the server parses it",
                ),
              note: z.string().max(1000).optional(),
            })
            .strict(),
        )
        .max(20)
        .optional()
        .describe(
          "Up to 20 worked examples: a question and the query that answers it on this graph",
        ),
      expected_version: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "The version get_rewrite_profile returned (0 for none): another stored version answers 409 conflict and stores nothing",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Check the profile and answer what a write would store, without storing it",
        ),
      ...graphScope,
    })
    .strict(),
]);

/**
 * MCP's `registerTool` advertises a JSON Schema for an input only when the
 * schema is a ZodObject (the SDK reads `.shape` via `normalizeObjectSchema`). A
 * `z.discriminatedUnion` has `.options`, not `.shape`, so the SDK silently falls
 * back to an empty `{ type: "object", properties: {} }` advertisement — and
 * clients then stringify every object-valued argument (for example, the
 * structured-query `body`), which the server
 * rejects as `Expected object, received string`.
 *
 * Flatten the union into a single ZodObject purely for advertisement and
 * transport: the discriminant becomes an enum, every variant field is merged in
 * as optional, and unknown keys pass through. Each handler still `safeParse`s the
 * raw args against the original strict union before dispatching, so per-variant
 * required/forbidden fields are enforced exactly as before.
 */
export function advertiseUnion(
  discriminator: string,
  union: z.ZodDiscriminatedUnion<string, z.AnyZodObject[]>,
) {
  const merged: z.ZodRawShape = {};
  const variants: string[] = [];
  for (const option of union.options) {
    for (const [key, field] of Object.entries(option.shape as z.ZodRawShape)) {
      const schema = field as z.ZodTypeAny;
      if (key === discriminator) {
        const value = (schema as z.ZodLiteral<string>).value;
        if (!variants.includes(value)) variants.push(value);
        continue;
      }
      if (!(key in merged))
        merged[key] = schema.isOptional() ? schema : schema.optional();
    }
  }
  return z
    .object({
      [discriminator]: z
        .enum(variants as [string, ...string[]])
        .describe(`Selects the variant (one of: ${variants.join(", ")}).`),
      ...merged,
    })
    .passthrough();
}

export const inspectWireSchema = advertiseUnion("action", inspectInputSchema);
export const queryWireSchema = advertiseUnion("mode", queryInputSchema);
export const configureWireSchema = advertiseUnion(
  "action",
  configureInputSchema,
);
