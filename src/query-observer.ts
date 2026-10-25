/** Local opt-in query measurements. No event contains query or response data. */
export type McpQueryStage =
  | "query_pin_metadata"
  | "query_http_total"
  | "query_results_parse"
  | "query_envelope"
  | "query_render";

export interface McpQueryStageEvent {
  stage: McpQueryStage;
  durationMs: number;
  outcome: "success" | "error";
  mode: "sparql" | "structured";
  continuation: boolean;
  row_limit: number;
  offset: number;
  received_rows?: number;
  returned_rows?: number;
  cursor_bytes?: number;
  text_bytes?: number;
}

/** What the approval step of a destructive call decided. */
export type McpApprovalDecision =
  /** The person ticked the box. */
  | "approved"
  /** The person declined, or left the box unticked. */
  | "declined"
  | "cancelled"
  /** The approval request itself failed. */
  | "failed"
  /** The client cannot show the question, so the call was refused. */
  | "unavailable"
  /** The client cannot show the question; LBB_MCP_DESTRUCTIVE=allow let it run. */
  | "allowed_by_setting";

/**
 * One tool call, for the server's log. It holds no arguments, texts or
 * keys: the tool, its action, the outcome and the JSON-RPC request id.
 */
export interface McpToolCallEvent {
  event: "mcp_tool_call";
  tool: string;
  /** The call's `action` (or `mode`), when it names one. */
  action?: string;
  outcome: "ok" | "error";
  /** The error code of a failed call, for example approval_declined. */
  code?: string;
  /** What the approval step decided, when the call is destructive. */
  approval?: McpApprovalDecision;
  request_id: string | number;
}

export interface LbbServerOptions {
  /**
   * A destructive call when the client cannot ask the person (no MCP form
   * elicitation): "refuse" returns approval_required and sends nothing;
   * "allow" sends it without a question. Default: "allow" when the
   * environment sets LBB_MCP_DESTRUCTIVE=allow, else "refuse".
   */
  destructiveWithoutApproval?: "refuse" | "allow";
  /** Receives one event per tool call. Default: a JSON line on stderr. */
  log?: (event: Readonly<McpToolCallEvent>) => void;
  /** Query text only; fitting and rendering always use this same format. */
  queryTextFormat?: "compact" | "pretty";
  timing?: {
    /** Monotonic milliseconds; defaults to performance.now(). */
    now?: () => number;
    observe: (event: Readonly<McpQueryStageEvent>) => void;
  };
}

type QueryCounts = Pick<
  McpQueryStageEvent,
  "received_rows" | "returned_rows" | "cursor_bytes" | "text_bytes"
>;
type QueryIdentity = Pick<
  McpQueryStageEvent,
  "mode" | "continuation" | "row_limit" | "offset"
>;

function count(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0;
}

/** Each tool call owns its small counter record; servers may serve concurrently. */
export function queryTiming(
  options: LbbServerOptions,
  identity: QueryIdentity,
) {
  const timing = options.timing;
  const counts: QueryCounts = {};
  const now = () => {
    try {
      const value = timing?.now?.() ?? performance.now();
      return Number.isFinite(value) ? value : performance.now();
    } catch {
      return performance.now();
    }
  };
  const emit = (
    stage: McpQueryStage,
    start: number,
    outcome: "success" | "error",
  ) => {
    if (!timing) return;
    const elapsed = now() - start;
    const event: McpQueryStageEvent = {
      stage,
      durationMs: Number.isFinite(elapsed)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed))
        : 0,
      outcome,
      mode: identity.mode,
      continuation: identity.continuation,
      row_limit: count(identity.row_limit),
      offset: count(identity.offset),
      ...counts,
    };
    try {
      // Async callbacks also remain isolated even though observation is not
      // awaited and the public callback contract does not require a Promise.
      const pending = timing.observe(event) as unknown;
      if (
        pending &&
        typeof (pending as { then?: unknown }).then === "function"
      ) {
        void Promise.resolve(pending).catch(() => {});
      }
    } catch {
      // A local observer cannot turn a successful query into a failure.
    }
  };
  return {
    counts(update: QueryCounts) {
      if (!timing) return;
      // Explicit keys prevent caller-supplied objects from adding fields.
      for (const key of [
        "received_rows",
        "returned_rows",
        "cursor_bytes",
        "text_bytes",
      ] as const) {
        const value = update[key];
        if (value !== undefined) counts[key] = count(value);
      }
    },
    measure<T>(stage: McpQueryStage, operation: () => T): T {
      if (!timing) return operation();
      const start = now();
      let outcome: "success" | "error" = "error";
      try {
        const result = operation();
        outcome = "success";
        return result;
      } finally {
        emit(stage, start, outcome);
      }
    },
    measureAsync<T>(
      stage: McpQueryStage,
      operation: () => Promise<T>,
    ): Promise<T> {
      if (!timing) return operation();
      const start = now();
      return (async () => {
        let outcome: "success" | "error" = "error";
        try {
          const result = await operation();
          outcome = "success";
          return result;
        } finally {
          emit(stage, start, outcome);
        }
      })();
    },
  };
}
