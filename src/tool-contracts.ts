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
  branch?: string;
  detail: Detail;
  row_limit: number;
  offset: number;
  query?: string;
  body?: Record<string, unknown>;
  as_of?: string;
  as_of_commit_seq?: number;
};

export const DEFAULT_DETAIL: Detail = "compact";
export const HARD_OUTPUT_CHARS = 80_000;
export const MAX_QUERY_ROW_LIMIT = 5_000;
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
  branch: z
    .string()
    .optional()
    .describe("Branch to target; defaults to the connection's branch"),
};

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonObjectArraySchema = z.array(jsonObjectSchema);
export const readScope = { detail: detailSchema, ...graphScope };

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

export const inspectInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("guide"), ...readScope }).strict(),
  z.object({ action: z.literal("ontology"), ...readScope }).strict(),
  z
    .object({ action: z.literal("ontology_conformance"), ...readScope })
    .strict(),
  z.object({ action: z.literal("schema"), ...readScope }).strict(),
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
      action: z.literal("entity"),
      entity_id: z
        .string()
        .optional()
        .describe("Entity id (hex); alternative to entity_type+name"),
      entity_type: z.string().optional(),
      name: z.string().optional(),
      as_of: z
        .string()
        .optional()
        .describe(
          "Valid-time snapshot pin (RFC3339): reproduce the node as of this instant.",
        ),
      as_of_commit_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Snapshot pin: reproduce the node (state, edges, history) as of this commit_seq.",
        ),
      ...readScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("state"),
      entity_type: z.string(),
      name: z.string(),
      relation: z.string().optional(),
      as_of: z.string().optional(),
      as_of_commit_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Snapshot pin: reproduce the state as of this commit_seq, hiding later commits. Errors if past head.",
        ),
      ...readScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("history"),
      entity_type: z.string(),
      name: z.string(),
      relation: z.string().optional(),
      ...readScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("why"),
      source_type: z.string(),
      source_name: z.string(),
      relation: z.string(),
      target_type: z.string(),
      target_name: z.string(),
      ...readScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("traverse"),
      entity_type: z.string(),
      name: z.string(),
      relations: z.array(z.string()).optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
      max_hops: z.number().int().positive().max(6).optional(),
      top_k: z.number().int().positive().optional(),
      ...readScope,
    })
    .strict(),
  z
    .object({
      action: z.literal("transitions"),
      entity_type: z.string(),
      name: z.string(),
      relation: z
        .string()
        .describe(
          "State/status relation to trace, e.g. IN_STAGE or HAS_STATUS",
        ),
      as_of: z.string().optional(),
      as_of_commit_seq: z.number().int().nonnegative().optional(),
      ...readScope,
    })
    .strict(),
]);

// The graph's RDF projection uses a fixed IRI scheme; teaching it here lets an
// agent write a valid query on the first attempt instead of round-tripping
// through the ontology to reverse-engineer term IRIs.
export const SPARQL_IRI_GUIDE =
  'IRI scheme: relations are <https://littlebigbrain.com/r/NAME> (NAME lowercased, e.g. writes_to; reverse a relation with the ^ path operator, no stored inverse triple). Types are <https://littlebigbrain.com/class/NAME> (lowercased), matched as `?x a <…/class/NAME>` with rdfs:subClassOf closure on by default. Property fields are <https://littlebigbrain.com/p/NAME> (lowercased). The local name is ALWAYS lowercase — an uppercase one (e.g. <…/r/FOR_CLIENT>) is a different, non-existent IRI that silently matches nothing; this tool auto-lowercases the local name of /r/, /class/, and /p/ IRIs for you and adds a `notes` entry when it does, so a stray uppercase still resolves. (Structured mode\'s `predicate` is case-insensitive on its own.) Entities are content-addressed <https://littlebigbrain.com/e/HASH> — never build an entity IRI from a name; anchor a named entity by its label instead: `?e <http://www.w3.org/2000/01/rdf-schema#label> "Acme"`. Discover the exact relation and type names with lbb_inspect action=ontology. SELECT and ASK only (CONSTRUCT/DESCRIBE are rejected).';

export const queryInputSchema: z.ZodDiscriminatedUnion<
  "mode",
  z.AnyZodObject[]
> = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("structured"),
      body: jsonObjectSchema
        .optional()
        .describe(
          'Structured SPARQL-subset or analytics request body. Shape: { patterns: [{ subject, predicate, object }], filters?, group_by?, group_keys?, aggregates?, having?, order_by?, select?, limit?, distinct? }. Each pattern term is { var: "x" } or a fixed { entity: { entity_type, name } }; `predicate` is a relation name and is case-insensitive here (FOR_CLIENT and for_client both resolve — unlike SPARQL text, which needs the lowercased IRI local name). ' +
            "FILTER — `filters` is a list of conditions, each of exact shape " +
            '{ "compare": { "op": <op>, "left": <term>, "right": <term> } } (or { "and": [<filter>…] }, { "or": [<filter>…] }, { "not": <filter> }). ' +
            "`op` is one of eq | ne | lt | le | gt | ge (NOT the symbols =,<,>). Each <term> is exactly one of " +
            '{ "var": "x" }, { "property": { "var": "x", "field": "amount" } } (a typed scalar attribute), or ' +
            '{ "value": <typed> } — and <typed> is exactly one wrapper: { "str": "…" }, { "i64": 5 }, { "f64": 0.9 }, { "bool": true }, { "date_time": "2026-01-01" } (RFC3339), or { "entity": { "entity_type": "T", "name": "N" } }. ' +
            'Complete runnable example — deals whose amount ≥ 1000000: { "patterns": [{ "subject": { "var": "d" }, "predicate": "for_client", "object": { "var": "c" } }], "filters": [{ "compare": { "op": "ge", "left": { "property": { "var": "d", "field": "amount" } }, "right": { "value": { "f64": 1000000 } } } }] }. ' +
            "Comparisons use the field's real declared type (numbers as numbers, datetimes as instants), so they run server-side. " +
            'GROUP BY supports both entity-identity keys (group_by: ["s"]) and typed scalar keys via group_keys: a property value ({ property: { var, field, as } }) or a calendar bucket of a datetime property ({ date_bucket: { var, field, granularity: year|month|week|day|hour, as } }). Scalar keys come back per group under value_keys[as] — so a per-area breakdown or a commits-per-month time series is one server-side query, no client-side bucketing. Worked example -- commits per area per month in one query: { "patterns": [{ "subject": { "var": "c" }, "predicate": "committed_to", "object": { "var": "repo" } }], "group_keys": [{ "date_bucket": { "var": "c", "field": "committed_at", "granularity": "month", "as": "m" } }, { "property": { "var": "c", "field": "area", "as": "area" } }], "aggregates": [{ "func": "count", "as": "n" }], "order_by": [{ "var": "m" }] } -- area and committed_at are typed entity attributes (set via entity_properties; readable flat under attributes, never a nested metadata blob), and each group returns value_keys.m + value_keys.area + aggregates.n. `having: [...]` takes the same filter shape over the aggregated groups (e.g. { "compare": { "op": "gt", "left": { "var": "n" }, "right": { "value": { "i64": 10 } } } }); it is evaluated only on this grouped path, NOT alongside `combinators` (UNION/OPTIONAL/MINUS), which route to the analytics engine. Cheap aggregate count: pair an equality having (e.g. { "compare": { "op": "eq", "left": { "var": "n" }, "right": { "value": { "i64": 4 } } } }) with row_limit: 1 -- the response row_page.total reports how many groups match without materializing them all, so you read the count off row_page.total instead of paging every matching row. For snapshot pinning prefer the top-level `as_of` / `as_of_commit_seq` arguments below; a bare `as_of` key inside the body is rejected (the body\'s valid-time field is `as_of_valid_time`).',
        ),
      as_of: z
        .string()
        .optional()
        .describe(
          "Snapshot pin (valid-time, RFC3339): evaluate the body as of this instant. Folded into the request's `as_of_valid_time`. Top-level here is the supported spelling — a bare `as_of` inside the body is rejected, since the server silently ignores it.",
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
      query: z
        .string()
        .optional()
        .describe(
          `SPARQL 1.1 query text (SELECT or ASK). ${SPARQL_IRI_GUIDE} Example: SELECT ?service ?db WHERE { ?service <https://littlebigbrain.com/r/writes_to> ?db } LIMIT 10`,
        ),
      as_of: z.string().optional(),
      as_of_commit_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Snapshot pin: run the query as of this commit_seq. Errors if past head.",
        ),
      row_limit: rowLimitSchema,
      cursor: cursorSchema,
      ...readScope,
    })
    .strict(),
  z
    .object({
      mode: z.literal("analyze"),
      metric: z
        .enum(["entity_types", "relations", "overview", "facets", "sparql"])
        .optional(),
      chart: z.enum(["bar", "pie"]).optional(),
      top_k: z.number().int().positive().optional(),
      query: z.string().optional(),
      field: z.string().optional(),
      sparql: jsonObjectSchema.optional(),
      ...readScope,
    })
    .strict(),
]);

export const configureInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("define_ontology"),
      graph: z.string().describe("Graph to create or redefine"),
      branch: graphScope.branch,
      entity_types: jsonObjectArraySchema.optional(),
      relations: jsonObjectArraySchema.optional(),
      source: z.string().optional(),
      format: ontologyFormatSchema.optional(),
      merge_default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish_schema"),
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
          "Apply subtractive ops (narrow/remove) even when current data conflicts; affected records are kept and begin to warn. Default false rejects a conflicting subtractive request and reports the conflicts.",
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
 * transport: the discriminant becomes an enum, every branch field is merged in
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
