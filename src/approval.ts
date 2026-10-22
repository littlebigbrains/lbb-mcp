import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { LbbClient } from "@littlebigbrain/client";
import type {
  LbbServerOptions,
  McpApprovalDecision,
  McpToolCallEvent,
} from "./query-observer.js";
import { updateOperations } from "./sparql-update.js";
import { ToolError, errorResult } from "./tool-runtime.js";

/** The `extra` argument of a tool callback. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ErrorResult = ReturnType<typeof errorResult>;

/** How long the person has to answer an approval request. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** The environment setting that lets destructive calls run without a question. */
export const DESTRUCTIVE_SETTING = "LBB_MCP_DESTRUCTIVE";

/** The approval rule, for the description of a destructive tool. */
export const APPROVAL_TEXT = `The server asks the person to approve it through the client (MCP form elicitation) and sends nothing when they decline (approval_declined). A client that cannot show the question gets approval_required and nothing is sent, unless the MCP server's environment sets ${DESTRUCTIVE_SETTING}=allow.`;

/** What a destructive call asks the person. */
export interface ApprovalRequest {
  /**
   * The question, naming what the call deletes or removes first. A
   * function runs only when the person is asked, so the call can read the
   * records it names; its error is the tool's error.
   */
  message: string | (() => Promise<string>);
}

/** Control characters, line and paragraph separators, and bidirectional controls. */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- these are the characters a name must not carry into a question
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapeChar(c: string): string {
  switch (c) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

/**
 * A name or a value on one line of a question: newlines and other control
 * characters escaped, so a name cannot add lines of its own; at most `max`
 * characters.
 */
export function oneLine(text: unknown, max = 200): string {
  const escaped = String(text).replace(UNSAFE, escapeChar);
  return escaped.length > max ? `${escaped.slice(0, max)} …` : escaped;
}

/**
 * Text quoted under a line of a question: every line indented by four
 * spaces, other control characters escaped, at most `max` characters.
 */
export function quoteBlock(text: string, max: number): string {
  const normal = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const shown = normal.length > max ? normal.slice(0, max) : normal;
  const body = shown
    .split("\n")
    .map((line) => `    ${line.replace(UNSAFE, escapeChar)}`)
    .join("\n");
  return normal.length > max
    ? `${body}\n    … ${(normal.length - max).toLocaleString("en-US")} more characters`
    : body;
}

/** `graph "<name>"`: the graph a call targets, for a person to read. */
export function graphLabel(client: LbbClient, graph?: string): string {
  const name = graph ?? client.graphName;
  return name ? `graph "${oneLine(name)}"` : "the connection's graph";
}

/** The tool registry of one MCP server: a call log, and the approval step. */
export interface ToolHost {
  readonly server: McpServer;
  /** `server.registerTool`, with one log event per call. */
  readonly register: McpServer["registerTool"];
  /**
   * Ask the person before a destructive call (principle 13: destructive
   * writes need a person's approval). A client with form elicitation shows
   * the question with one confirm box; a decline, a cancel or an unticked
   * box sends nothing. A client without form elicitation cannot ask, so
   * the call is refused with approval_required, unless the server's
   * environment sets LBB_MCP_DESTRUCTIVE=allow. No tool argument lets a
   * call through: an agent sets the arguments. Returns undefined when the
   * call may go ahead, else the error result to return.
   */
  approve(
    extra: ToolExtra,
    request: ApprovalRequest,
  ): Promise<ErrorResult | undefined>;
}

/** A word of the log: an action or an error code, never free text. */
function token(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function defaultLog(event: Readonly<McpToolCallEvent>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** The host of one server's tools; `options` name the approval setting and the log. */
export function toolHost(
  server: McpServer,
  options: LbbServerOptions = {},
): ToolHost {
  const setting =
    options.destructiveWithoutApproval ??
    (process.env[DESTRUCTIVE_SETTING]?.trim().toLowerCase() === "allow"
      ? "allow"
      : "refuse");
  const log = options.log ?? defaultLog;
  const calls = new WeakMap<object, { approval?: McpApprovalDecision }>();
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    callback: (...params: unknown[]) => unknown,
  ) => unknown;

  const register = ((
    name: string,
    config: unknown,
    callback: (...params: unknown[]) => unknown,
  ) =>
    registerTool(name, config, async (...params: unknown[]) => {
      const extra = params[params.length - 1] as ToolExtra;
      const record: { approval?: McpApprovalDecision } = {};
      calls.set(extra, record);
      const args = (params.length > 1 ? params[0] : undefined) as
        { action?: unknown; mode?: unknown } | undefined;
      const action = token(args?.action ?? args?.mode, /^[a-z_]{1,40}$/);
      const emit = (outcome: "ok" | "error", code?: string) => {
        try {
          log({
            event: "mcp_tool_call",
            tool: name,
            ...(action ? { action } : {}),
            outcome,
            ...(code ? { code } : {}),
            ...(record.approval ? { approval: record.approval } : {}),
            request_id: extra.requestId,
          });
        } catch {
          // A log that fails never fails the call.
        }
      };
      try {
        const result = (await callback(...params)) as {
          isError?: boolean;
          structuredContent?: { error?: { code?: unknown } };
        };
        emit(
          result?.isError ? "error" : "ok",
          result?.isError
            ? token(result.structuredContent?.error?.code, /^[a-z0-9_.]{1,64}$/)
            : undefined,
        );
        return result;
      } catch (error) {
        emit("error", "exception");
        throw error;
      }
    })) as McpServer["registerTool"];

  const approve = async (
    extra: ToolExtra,
    request: ApprovalRequest,
  ): Promise<ErrorResult | undefined> => {
    const record = calls.get(extra);
    const decide = (decision: McpApprovalDecision) => {
      if (record) record.approval = decision;
    };
    if (!server.server.getClientCapabilities()?.elicitation?.form) {
      if (setting === "allow") {
        decide("allowed_by_setting");
        return undefined;
      }
      decide("unavailable");
      return errorResult(
        new ToolError(
          "approval_required",
          `This call deletes or removes data, and this client cannot ask the person to approve it (it has no MCP form elicitation), so nothing was sent. Make this change in the console or with the TypeScript or Python SDK, or from an MCP client that can show the question. On an MCP server you run yourself, the person can set ${DESTRUCTIVE_SETTING}=allow in its environment; the hosted endpoint never allows it.`,
        ),
      );
    }
    let message: string;
    try {
      message =
        typeof request.message === "string"
          ? request.message
          : await request.message();
    } catch (error) {
      return errorResult(error);
    }
    try {
      const answer = await server.server.elicitInput(
        {
          mode: "form",
          message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Approve",
                description: "Tick to run this call. It cannot be undone.",
                default: false,
              },
            },
            required: ["confirm"],
          },
        },
        {
          relatedRequestId: extra.requestId,
          signal: extra.signal,
          timeout: APPROVAL_TIMEOUT_MS,
        },
      );
      if (answer.action === "accept" && answer.content?.confirm === true) {
        decide("approved");
        return undefined;
      }
      decide(answer.action === "cancel" ? "cancelled" : "declined");
    } catch (error) {
      decide("failed");
      return errorResult(
        new ToolError(
          "approval_failed",
          `The approval request failed, so nothing was sent: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return errorResult(
      new ToolError(
        "approval_declined",
        "The person declined, so nothing was sent.",
      ),
    );
  };

  return { server, register, approve };
}

/** `1 link`, `2 links`. */
export function counted(n: number, noun: string, plural = `${noun}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? noun : plural}`;
}

/** `a`, `a and b`, `a, b and c`. */
function joined(parts: string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The first 20 lines, then a count of the rest. */
function listed(lines: string[], noun: string): string[] {
  return lines.length > 20
    ? [...lines.slice(0, 20), `- and ${lines.length - 20} more ${noun}`]
    : lines;
}

type NamedRecord = { type: string; name: string };

/** The retract question: the counts, then every link and record it removes, the first 20 of each. */
export function retractMessage(
  where: string,
  edges: { source: NamedRecord; relation: string; target: NamedRecord }[],
  entities: NamedRecord[],
): string {
  const record = (r: NamedRecord) => `${oneLine(r.name)} (${oneLine(r.type)})`;
  const what = joined([
    ...(edges.length ? [counted(edges.length, "link")] : []),
    ...(entities.length
      ? [`every current link of ${counted(entities.length, "record")}`]
      : []),
  ]);
  return [
    `Retract ${what} from ${where}?`,
    ...listed(
      edges.map(
        (edge) =>
          `- the link ${record(edge.source)} ${oneLine(edge.relation)} ${record(edge.target)}`,
      ),
      "links",
    ),
    ...listed(
      entities.map((entity) => `- every current link of ${record(entity)}`),
      "records",
    ),
    "The records and their history stay readable in as_of reads.",
  ].join("\n");
}

/**
 * An `evolve_ontology` operation, as the tool or a suggestion holds it.
 * Only the fields a removal names are read.
 */
export type OntologyOpLike = {
  op: string;
  name?: unknown;
  relation?: unknown;
  remove_domain?: unknown;
  remove_range?: unknown;
};

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((name) => oneLine(name)) : [];
}

/** What one operation removes, one line each. */
function removals(op: OntologyOpLike): string[] {
  switch (op.op) {
    case "remove_entity_type":
      return [`- the entity type ${oneLine(op.name)}`];
    case "remove_relation":
      return [`- the relation ${oneLine(op.name)}`];
    case "narrow_relation": {
      const domain = names(op.remove_domain);
      const range = names(op.remove_range);
      return [
        ...(domain.length
          ? [
              `- ${domain.join(", ")} from the source types (domain) of the relation ${oneLine(op.relation)}`,
            ]
          : []),
        ...(range.length
          ? [
              `- ${range.join(", ")} from the target types (range) of the relation ${oneLine(op.relation)}`,
            ]
          : []),
      ];
    }
    default:
      return [];
  }
}

/** Whether an operation removes: a type, a relation, or a relation's source or target types. */
export function removesFromOntology(op: OntologyOpLike): boolean {
  return removals(op).length > 0;
}

/** `1 entity type, 1 relation and 3 source or target types`. */
function removalCounts(ops: OntologyOpLike[]): string {
  const of = (kind: string) => ops.filter((op) => op.op === kind).length;
  const types = ops.reduce(
    (sum, op) =>
      op.op === "narrow_relation"
        ? sum + names(op.remove_domain).length + names(op.remove_range).length
        : sum,
    0,
  );
  return joined([
    ...(of("remove_entity_type")
      ? [counted(of("remove_entity_type"), "entity type")]
      : []),
    ...(of("remove_relation")
      ? [counted(of("remove_relation"), "relation")]
      : []),
    ...(types
      ? [
          counted(
            types,
            "source or target type of a relation",
            "source or target types of relations",
          ),
        ]
      : []),
  ]);
}

/**
 * The question of an `evolve_ontology` call that removes: the counts, then
 * what `remove_entity_type`, `remove_relation` and the `remove_domain` and
 * `remove_range` of `narrow_relation` remove, the first 20. Undefined when
 * the call removes nothing.
 */
export function ontologyRemovalMessage(
  where: string,
  ops: OntologyOpLike[],
): string | undefined {
  const removing = ops.filter(removesFromOntology);
  if (!removing.length) return undefined;
  const others = ops.length - removing.length;
  const tombstones = removing.some(
    (op) => op.op === "remove_entity_type" || op.op === "remove_relation",
  );
  return [
    `Change the ontology of ${where}? The change removes ${removalCounts(removing)}:`,
    ...listed(removing.flatMap(removals), "removals"),
    ...(others
      ? [`It also applies ${counted(others, "other operation")}.`]
      : []),
    ...(tombstones
      ? [
          "A removed type or relation stays readable in old records. New commits that use it fail.",
        ]
      : []),
  ].join("\n");
}

/** The facts a review item commits, as far as a question names them. */
export type FactsLike = {
  triplets?: unknown[] | null;
  entity_properties?: unknown[] | null;
  replace_owned?: {
    subjects?: unknown[] | null;
    retract_entities?: unknown[] | null;
  } | null;
};

/** `2 links and 1 field row; …`: what committing `facts` writes and removes. */
export function factsSummary(facts: FactsLike): string | undefined {
  const writes = joined([
    ...(facts.triplets?.length ? [counted(facts.triplets.length, "link")] : []),
    ...(facts.entity_properties?.length
      ? [counted(facts.entity_properties.length, "field row")]
      : []),
  ]);
  const owned = facts.replace_owned;
  const parts = [
    ...(writes ? [`commits ${writes}`] : []),
    ...(owned?.subjects?.length
      ? [
          `removes the owned links and fields it does not write again on ${counted(owned.subjects.length, "record")}`,
        ]
      : []),
    ...(owned?.retract_entities?.length
      ? [`retracts ${counted(owned.retract_entities.length, "record")}`]
      : []),
  ];
  return parts.length ? parts.join("; ") : undefined;
}

/** A review item an answer would commit or apply. */
export interface ReviewTarget {
  id: string;
  title: string;
  kind: string;
  question?: {
    property?: string | null;
    value?: unknown;
    unit?: string | null;
  } | null;
  subject?: { name?: string | null } | null;
  facts?: FactsLike | null;
}

/** A change item's suggestion: its operations and facts, or undefined when it could not be read. */
export type ChangeDetail =
  { ops: OntologyOpLike[]; facts?: FactsLike | null } | undefined;

/**
 * The question of a review answer that commits or applies: the count and
 * the effect first (how many value items commit a value, how many change
 * items apply an ontology change, and what those changes remove), then
 * each item, the first 20. `unchanged` counts the other answered items.
 */
export function reviewAnswerMessage(
  where: string,
  answer: { decision: "accept" | "correct"; value?: unknown },
  items: ReviewTarget[],
  changes: Map<string, ChangeDetail>,
  unchanged: number,
): string {
  const values = items.filter((item) => item.kind === "value");
  const changeItems = items.filter((item) => item.kind === "change");
  const total = items.length + unchanged;
  const correct = answer.decision === "correct";
  const effects = [
    ...(values.length
      ? [
          values.length === 1
            ? `1 value item commits ${correct ? "the corrected value" : "its value"}`
            : `${counted(values.length, "value item")} commit ${correct ? "the corrected value" : "their values"}`,
        ]
      : []),
    ...(changeItems.length
      ? [
          changeItems.length === 1
            ? "1 change item applies its ontology change"
            : `${counted(changeItems.length, "change item")} apply their ontology changes`,
        ]
      : []),
  ];
  const head = `${correct ? "Correct" : "Accept"} ${counted(total, "review item")} on ${where}${correct ? ` to ${oneLine(JSON.stringify(answer.value ?? null))}` : ""}? ${joined(effects)}.`;
  const lines: string[] = [];
  for (const item of items.slice(0, 20)) {
    const label = `- "${oneLine(item.title)}" (${oneLine(item.id)})`;
    const facts = item.facts ? factsSummary(item.facts) : undefined;
    if (item.kind === "value") {
      const property = item.question?.property;
      const value = correct ? answer.value : item.question?.value;
      const unit =
        !correct && item.question?.unit ? ` ${item.question.unit}` : "";
      const subject = item.subject?.name
        ? ` on ${oneLine(item.subject.name)}`
        : "";
      const what = property
        ? `${oneLine(property)} = ${oneLine(JSON.stringify(value ?? null))}${oneLine(unit)}${subject}`
        : "its value";
      lines.push(`${label}: ${what}${facts ? `; ${facts}` : ""}`);
      continue;
    }
    const detail = changes.get(item.id);
    if (!detail) {
      lines.push(
        `${label}: its ontology change and facts could not be read here`,
      );
      continue;
    }
    const removing = detail.ops.flatMap(removals);
    const changeFacts = detail.facts ? factsSummary(detail.facts) : undefined;
    lines.push(
      `${label}: ${counted(detail.ops.length, "ontology operation")}${changeFacts ? `; ${changeFacts}` : ""}${removing.length ? "; the change removes:" : ""}`,
    );
    lines.push(...listed(removing, "removals").map((line) => `    ${line}`));
  }
  if (items.length > 20)
    lines.push(`- and ${counted(items.length - 20, "more item")}`);
  return [
    head,
    ...lines,
    ...(unchanged
      ? [
          unchanged === 1
            ? "1 other item changes nothing in the graph."
            : `${counted(unchanged, "other item")} change nothing in the graph.`,
        ]
      : []),
  ].join("\n");
}

/** The target classes a SHACL source names, as written. */
function targetClasses(source: string): string[] {
  const found = source.matchAll(
    /(?:\bsh:targetClass|<http:\/\/www\.w3\.org\/ns\/shacl#targetClass>)\s+(<[^>\s]*>|[A-Za-z][\w.-]*:[\w.-]*|:[\w.-]*)/g,
  );
  return [...new Set([...found].map((match) => oneLine(match[1])))];
}

/** The question of a shape publish in reject mode. */
export function shapesRejectMessage(
  where: string,
  shapes: { source: string; format?: string },
): string {
  const targets = targetClasses(shapes.source);
  return [
    `Publish these SHACL rules on ${where} in reject mode? From then on, a write that breaks a rule fails, and the error lists the violations.`,
    ...(targets.length
      ? [
          `The rules name ${counted(targets.length, "target class", "target classes")}:`,
          ...listed(
            targets.map((target) => `- ${target}`),
            "target classes",
          ),
        ]
      : ["No target class was read from the rules."]),
    `The rules are ${counted(shapes.source.length, "character")} of ${oneLine(shapes.format ?? "auto")} text.`,
  ].join("\n");
}

/** The most characters of one removing operation a question quotes. */
const OPERATION_CHARS = 1_500;
/** The most characters of removing operations one question quotes. */
const UPDATE_CHARS = 6_000;

/**
 * The question of a SPARQL Update that can remove statements: the
 * operations that remove come first (DELETE, CLEAR, DROP, MOVE, COPY),
 * each quoted on lines of its own, then the forms of the other operations.
 */
export function sparqlUpdateMessage(where: string, update: string): string {
  const operations = updateOperations(update);
  const removing = operations
    .map((operation, i) => ({ operation, n: i + 1 }))
    .filter(({ operation }) => operation.removes);
  if (!removing.length) {
    return [
      `Run this SPARQL Update on ${where}? Its text names DELETE, CLEAR, DROP, MOVE or COPY, so it may remove statements:`,
      quoteBlock(update, 2_000),
    ].join("\n");
  }
  const lines = [
    `Run this SPARQL Update on ${where}? ${
      operations.length === 1
        ? "It removes statements:"
        : removing.length === operations.length
          ? `All ${operations.length} of its operations remove statements:`
          : `${removing.length} of its ${operations.length} operations remove statements:`
    }`,
  ];
  let budget = UPDATE_CHARS;
  for (const { operation, n } of removing.slice(0, 20)) {
    const shown = Math.max(200, Math.min(OPERATION_CHARS, budget));
    lines.push(`- operation ${n}, ${oneLine(operation.form)}:`);
    lines.push(quoteBlock(operation.text, shown));
    budget -= Math.min(operation.text.length, shown);
  }
  if (removing.length > 20)
    lines.push(
      `- and ${counted(removing.length - 20, "more operation")} that remove`,
    );
  const others = operations.filter((operation) => !operation.removes);
  if (others.length)
    lines.push(
      `The other ${others.length === 1 ? "operation" : `${others.length} operations`}: ${[
        ...new Set(others.map((operation) => oneLine(operation.form))),
      ].join(", ")}.`,
    );
  return lines.join("\n");
}
