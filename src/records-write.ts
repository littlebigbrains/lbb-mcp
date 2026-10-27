/** Records-specific MCP framing; semantic admission belongs to the server. */
import { Buffer } from "node:buffer";
import {
  LbbCapabilityError,
  type LbbClient,
  type Schemas,
} from "@littlebigbrain/client";
import {
  graphLabel,
  oneLine,
  type ToolExtra,
  type ToolHost,
} from "./approval.js";
import { HARD_OUTPUT_CHARS } from "./tool-contracts.js";
import {
  contentHashKey,
  enrichError,
  errorResult,
  scoped,
  ToolError,
} from "./tool-runtime.js";

type Args = {
  records?: Record<string, unknown>;
  idempotencyKey?: string;
  expectedGraphEpoch?: string;
  graph?: string;
  legacyInputs: boolean;
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown) =>
  isObject(value)
    ? Object.keys(value).length > 0
    : Array.isArray(value) && value.length > 0;
function mayRemove(body: Record<string, unknown>): boolean {
  if (body.replace_scope === true) return true;
  for (const rows of [body.entities, body.relationships]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (
        isObject(row) &&
        (row.delete === true ||
          row.asserted === false ||
          nonempty(row.set) ||
          nonempty(row.unset) ||
          nonempty(row.remove))
      )
        return true;
    }
  }
  return false;
}
function approvalMessage(
  client: LbbClient,
  graph: string | undefined,
  body: Record<string, unknown>,
): string {
  const entities = Array.isArray(body.entities) ? body.entities.length : 0;
  const relationships = Array.isArray(body.relationships)
    ? body.relationships.length
    : 0;
  const action =
    body.replace_scope === true
      ? "Replace the complete desired support"
      : "Apply record edits that may replace or remove support";
  return `${action} in ${graphLabel(client, graph)}, owner "${oneLine(body.owner ?? "application")}", scope "${oneLine(body.scope ?? "default")}" (${entities} entities, ${relationships} relationships)? Other owners' support is retained. This does not erase retained history.`;
}

function boundedError(value: unknown, key?: string) {
  const original = errorResult(value);
  // A typed server error can also need receipt recovery. Keep its code/status
  // unchanged, but retain the derived key rather than making callers guess it.
  const identity = {
    ...original.structuredContent.error,
    ...(key !== undefined ? { idempotency_key: key } : {}),
  };
  const result = {
    ...original,
    structuredContent: { error: identity },
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: identity }, null, 2),
      },
    ],
  };
  if (Buffer.byteLength(result.content[0].text, "utf8") <= HARD_OUTPUT_CHARS)
    return result;
  const source = result.structuredContent.error as Record<string, unknown>;
  const short = (value: unknown, max = 512) =>
    typeof value === "string" &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= max
      ? value
      : null;
  const error = {
    type: short(source.type) ?? "tool_error",
    code: short(source.code) ?? "record_error_output_limit",
    message:
      "The complete server error exceeds the MCP output budget. Its code/status are retained; inspect the SDK or HTTP response for the full message. No complete commit receipt was returned.",
    message_truncated: true,
    status:
      typeof source.status === "number" && Number.isSafeInteger(source.status)
        ? source.status
        : null,
    param: short(source.param),
    request_id: short(source.request_id),
    doc_url: short(source.doc_url),
    ...(key !== undefined ? { idempotency_key: key } : {}),
  };
  const payload = { error };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export async function commitRecordsTool(
  host: ToolHost,
  client: LbbClient,
  extra: ToolExtra,
  args: Args,
) {
  let requestKey: string | undefined;
  try {
    if (args.legacyInputs)
      throw new ToolError(
        "record_payload_ambiguous",
        "mode=records cannot include legacy facts, feedback, retract, dry_run, observed_at or edge_idempotency arguments, even when empty or false",
      );
    if (!isObject(args.records) || args.records.version !== "records/1") {
      throw new ToolError(
        "record_version_unsupported",
        "mode=records requires a records object with explicit version records/1",
      );
    }
    // Capture before approval/capability I/O. Do not strip unknown fields,
    // normalize IRIs, bind friendly keys or copy the server's source policy.
    const raw = JSON.stringify(args.records);
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024)
      throw new ToolError(
        "record_payload_budget",
        "The records body exceeds the MCP one MiB request budget; use a bounded SDK request",
      );
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!isObject(body) || body.version !== "records/1")
      throw new ToolError(
        "record_version_unsupported",
        "the encoded records object must retain version records/1",
      );
    const graph = args.graph;
    const epoch = args.expectedGraphEpoch;
    const key =
      args.idempotencyKey ??
      contentHashKey(
        { graph: graph ?? client.graphName },
        { mode: "records", expected_graph_epoch: epoch, body },
      );
    if (key.trim().length === 0)
      throw new ToolError(
        "record_payload_invalid",
        "records idempotency_key must not be empty",
      );
    // This is an output-identity allowance, not a duplicate of HTTP key syntax.
    // It leaves room to return the FULL original key if receipt recovery fails.
    if (Buffer.byteLength(JSON.stringify(key), "utf8") > 8192)
      throw new ToolError(
        "record_payload_budget",
        "The idempotency key exceeds the MCP recovery-identity budget",
      );
    requestKey = key;
    if (mayRemove(body)) {
      const refused = await host.approve(extra, {
        message: approvalMessage(client, graph, body),
      });
      if (refused) return refused;
    }
    const result = await scoped(client, graph).records.commit(
      body as unknown as Schemas["RecordCommitRequest"],
      { idempotencyKey: key, expectedGraphEpoch: epoch },
    );
    const envelope = { summary: "lbb_commit.records", data: result };
    const text = JSON.stringify(envelope);
    if (Buffer.byteLength(text, "utf8") > HARD_OUTPUT_CHARS) {
      // Acceptance is already known; do not relabel it as a failed mutation or
      // an unknown outcome just because the full result cannot fit this tool.
      const error = {
        type: "tool_error",
        code: "record_accepted_output_limit",
        message:
          "The record commit was accepted, but its complete receipt exceeds the MCP output budget. Recover the original receipt with the same body/key through the SDK or HTTP API.",
        outcome: "accepted",
        idempotency_key: key,
        epoch: result.receipt.epoch,
        commit_seq: result.receipt.commit_seq,
      };
      const payload = { error };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: envelope,
    };
  } catch (error) {
    return boundedError(
      error instanceof LbbCapabilityError
        ? new ToolError("record_capability_unavailable", error.message)
        : await enrichError(client, error),
      requestKey,
    );
  }
}
