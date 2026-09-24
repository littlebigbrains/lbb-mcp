import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LbbClient } from "@littlebigbrain/client";
import { z } from "zod";
import { graphScope, detailSchema, advertiseUnion } from "./tool-contracts.js";
import { contentHashKey, errorResult, run, scoped } from "./tool-runtime.js";

const input = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("import"),
      source: z
        .string()
        .min(1)
        .describe(
          "Complete RDF document. Preserves OWL axioms, RDF lists, labels, comments, and external IRIs as graph facts.",
        ),
      format: z.enum(["turtle", "ntriples", "nquads", "trig"]).optional(),
      base_iri: z.string().optional(),
      blank_node_scope: z
        .string()
        .optional()
        .describe(
          "Stable document scope for blank labels across import chunks.",
        ),
      idempotency_key: z.string().optional(),
      ...graphScope,
      detail: detailSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      update: z
        .string()
        .min(1)
        .describe(
          "SPARQL INSERT DATA text to add axioms. Submitted unchanged. DELETE/WHERE/CLEAR and named graphs are currently unsupported and fail without mutation.",
        ),
      idempotency_key: z.string().optional(),
      ...graphScope,
      detail: detailSchema,
    })
    .strict(),
]);

export function registerRdfTool(server: McpServer, client: LbbClient): void {
  server.registerTool(
    "lbb_rdf",
    {
      description:
        "Store and extend complete RDF/OWL documents through MCP. import accepts Turtle/N-Triples/N-Quads/TriG without conversion; update executes INSERT DATA for additive edits. Replacing/removing axioms is unsupported; use a new versioned LBB graph for a revised document. Named RDF graphs are unsupported; Turtle/N-Triples use the default graph, and dataset formats must contain only default-graph quads. These write graph facts, distinct from lbb_configure's native schema metadata. A first RDF write selects RDF-native storage, which refuses later property-graph commits; choose the write workflow before bootstrap. Retries deduplicate by content unless idempotency_key is supplied. A completed write schedules publication; inspect action=publication and verify using lbb_query entailment=owl.",
      inputSchema: advertiseUnion("action", input),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (raw) => {
      const parsed = input.safeParse(raw);
      if (!parsed.success) return errorResult(parsed.error);
      const args = parsed.data;
      return run(client, `lbb_rdf.${args.action}`, args.detail, async () => {
        const target = scoped(client, args.graph);
        const { idempotency_key } = args;
        const operation = { ...args };
        delete operation.detail;
        delete operation.idempotency_key;
        const key =
          idempotency_key ?? contentHashKey({ graph: args.graph }, operation);
        if (args.action === "import") {
          return target.importRdf(args.source, {
            format: args.format ?? "turtle",
            baseIri: args.base_iri,
            blankNodeScope: args.blank_node_scope,
            strict: true,
            edgeIdempotency: "skip_unchanged",
            idempotencyKey: key,
          });
        }
        await target.request<void>("POST", "/update", {
          rawBody: args.update,
          contentType: "application/sparql-update",
          idempotencyKey: key,
        });
        return {
          accepted: true,
          idempotency_key: key,
          publication:
            "pending; inspect action=publication before verifying inferred results",
        };
      });
    },
  );
}
