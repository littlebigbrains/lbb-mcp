import { createHash } from "node:crypto";
import { z } from "zod";
import { type LbbClient } from "@littlebigbrain/client";
import { HARD_OUTPUT_CHARS, metadataPageSchema } from "./tool-contracts.js";
import { countsFor, stableJson } from "./tool-runtime.js";

type Request = z.infer<z.ZodObject<typeof metadataPageSchema>> & {
  action: "ontology" | "schema";
  graph?: string;
};
const cursorSchema = z
  .object({
    v: z.literal(1),
    action: z.enum(["ontology", "schema"]),
    graph: z.string().optional(),
    section: z.string().optional(),
    page_size: z.number().int().min(1).max(500),
    offset: z.number().int().nonnegative().safe(),
    fragment_offset: z.number().int().nonnegative().safe().optional(),
    fingerprint: z.string(),
  })
  .strict();

/** Stateless pagination of complete entries, including their full nested values.
 * A digest rejects mixed-version reads instead of skipping/repeating definitions
 * when schema or population counts change between pages. */
export async function metadataPage(client: LbbClient, args: Request) {
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (args.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new Error("invalid lbb_inspect cursor; restart without cursor");
    }
    for (const key of ["action", "graph", "section", "page_size"] as const) {
      if (args[key] !== undefined && args[key] !== cursor[key]) {
        throw new Error(`cursor ${key} does not match the supplied ${key}`);
      }
    }
  }
  const graph = cursor?.graph ?? args.graph;
  const section = cursor?.section ?? args.section;
  const pageSize = cursor?.page_size ?? args.page_size ?? 50;
  const target = client.withScope({ graph });
  const value = (args.action === "ontology"
    ? await target.ontologyView({ counts: true })
    : await target.schema.view()) as unknown as Record<string, unknown>;
  if (section !== undefined && !Array.isArray(value[section])) {
    throw new Error(
      `unknown metadata section '${section}'; choose ${Object.keys(value)
        .filter((k) => Array.isArray(value[k]))
        .join(", ")}`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(stableJson(value))
    .digest("hex");
  if (cursor && cursor.fingerprint !== fingerprint) {
    throw new Error(
      "ontology/schema metadata changed during pagination; restart without cursor to avoid mixing versions",
    );
  }
  const base = {
    v: 1 as const,
    action: args.action,
    graph,
    section,
    page_size: pageSize,
    fingerprint,
  };
  const arrays = Object.entries(value).filter(
    ([key, child]) =>
      Array.isArray(child) && (section === undefined || key === section),
  );
  const entries = arrays.flatMap(([key, items]) =>
    (items as unknown[]).map((item) => ({ key, item })),
  );
  const data: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).filter(([, child]) => !Array.isArray(child)),
  );
  for (const [key] of arrays) data[key] = [];
  const offset = cursor?.offset ?? 0;
  if (offset > entries.length)
    throw new Error("invalid lbb_inspect cursor offset");
  const makeEnvelope = (returned: number, fragmentOffset?: number) => {
    const end = offset + returned;
    const hasMore = end < entries.length;
    return {
      summary: `lbb_inspect.${args.action}: ${returned} complete metadata entries (${end}/${entries.length})`,
      data,
      counts: countsFor(value),
      row_page: {
        returned,
        total: entries.length,
        offset,
        limit: pageSize,
        has_more: hasMore,
        next_offset: hasMore ? end : undefined,
      },
      next: hasMore
        ? {
            action: args.action,
            graph,
            section,
            page_size: pageSize,
            cursor: Buffer.from(
              JSON.stringify({
                ...base,
                offset: end,
                fragment_offset: fragmentOffset,
              }),
            ).toString("base64url"),
          }
        : undefined,
    };
  };
  let returned = 0;
  for (const { key, item } of entries.slice(offset, offset + pageSize)) {
    (data[key] as unknown[]).push(item);
    if (
      JSON.stringify(makeEnvelope(returned + 1), null, 2).length >
      HARD_OUTPUT_CHARS
    ) {
      (data[key] as unknown[]).pop();
      if (returned === 0) {
        // Even one unusually large definition remains readable through MCP.
        // Reassemble serialized_json in order, then JSON.parse the full entry.
        const serialized = JSON.stringify(item);
        const start = cursor?.fragment_offset ?? 0;
        if (start >= serialized.length)
          throw new Error("invalid lbb_inspect fragment offset");
        let size = Math.min(16_000, serialized.length - start);
        for (;;) {
          const end = start + size;
          const complete = end === serialized.length;
          const result = {
            ...makeEnvelope(complete ? 1 : 0, complete ? undefined : end),
            summary: `lbb_inspect.${args.action}: fragment of ${key} entry ${offset}; concatenate serialized_json fragments then JSON.parse`,
            entry_fragment: {
              section: key,
              entry_offset: offset,
              char_offset: start,
              total_chars: serialized.length,
              serialized_json: serialized.slice(start, end),
              complete,
            },
          };
          if (JSON.stringify(result, null, 2).length <= HARD_OUTPUT_CHARS)
            return result;
          if (size === 1)
            throw new Error("metadata envelope exceeds MCP output budget");
          size = Math.max(1, Math.floor(size / 2));
        }
      }
      break;
    }
    returned++;
  }
  return makeEnvelope(returned);
}
