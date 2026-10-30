import type { LbbClient, Schemas } from "@littlebigbrain/client";
import { z } from "zod";
import {
  APPROVAL_TEXT,
  type ChangeDetail,
  type ToolHost,
  graphLabel,
  reviewAnswerMessage,
} from "./approval.js";
import {
  MUTATING,
  READ_ONLY,
  detailSchema,
  graphScope,
  regionSchema,
  reviewAnswerSchema,
  suggestedFactsBody,
  suggestedFactsSchema,
} from "./tool-contracts.js";
import {
  enrichError,
  errorResult,
  pageLimit,
  run,
  runPage,
  scoped,
} from "./tool-runtime.js";

/** The most items `GET /v1/reviews` returns in one page. */
const REVIEWS_PAGE_MAX = 500;
/** Reads of one answer's items (and their changes), at most this many at a time. */
const READS_AT_ONCE = 8;

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Whether an answer to `item` commits facts or applies an ontology change:
 * the one rule for which answers ask for approval. An item Evals filed (a
 * grade or a choice) commits nothing: its answer is its record's label.
 */
function commits(item: Schemas["ReviewItem"]): boolean {
  return (
    item.status === "open" &&
    item.scope !== "test" &&
    (item.kind === "value" || item.kind === "change")
  );
}

/** The producer of an item an agent files without its own `origin`. */
const MCP_ORIGIN: Schemas["SuggestionOrigin"] = {
  kind: "agent",
  id: "mcp agent",
  label: "mcp agent",
};

const kinds = ["change", "value", "choice", "grade", "answer"] as const;

const KINDS_TEXT =
  "Kinds and their decisions: change (accept an ontology change, identities or facts: accept, reject, cant_tell), value (confirm one value of a property, question.property and question.value: accept, correct with the right value, reject, cant_tell; accept and correct commit the value), choice (pick one of question.options: choose with option, cant_tell), grade (grade question.output on the scale question.options: choose with option, cant_tell), answer (answer question.prompt in words: accept with the text in note, cant_tell). Status is open, answered or withdrawn. Scope is live (default) or test: a test item writes nothing.";

const questionSchema = z
  .object({
    property: z
      .string()
      .optional()
      .describe("value: the property the value is for"),
    value: z
      .union([z.number(), z.string(), z.boolean()])
      .optional()
      .describe("value: the proposed value"),
    unit: z.string().optional().describe("value: the unit of a number"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Your confidence in the proposal, 0 to 1"),
    options: z
      .array(
        z
          .object({
            id: z.string().describe("1 to 64 characters of [A-Za-z0-9-_.:]"),
            label: z.string().max(200),
          })
          .strict(),
      )
      .optional()
      .describe("choice: the options; grade: the grades"),
    proposed: z
      .string()
      .optional()
      .describe("choice, grade: the id of the option you propose"),
    output: z.string().optional().describe("grade: the output to grade"),
    prompt: z.string().optional().describe("answer: the question in words"),
  })
  .strict();

export function registerReviewsTools(host: ToolHost, client: LbbClient): void {
  host.register(
    "lbb_reviews",
    {
      description: `Review items, read only: questions for a person (human in the loop) that workflows, integrations, agents and people file. ${KINDS_TEXT} list returns one page as the server sends it ({object, data, has_more, next_cursor}), the latest update first: pass next_cursor as cursor, with the same filters, for the next page. get reads one item (rev_…) with its question, evidence, answer and effects. patterns groups the live items that ask one decision, the largest first. Evals files the questions of model checks (origin_id evals:checks), calibration sessions (evals:calibration), golden queries (evals:golden) and the values the two arms of an experiment differ on (evals:datasets) as grade and choice items; eval_id keeps the items of one record (for evals:datasets, the dataset), and their answer is the record's label. An item of evals:datasets asks whether one value is right or wrong, and the origin names the dataset item, the property and the value. File, answer, comment on or withdraw items with lbb_reviews_manage.`,
      inputSchema: {
        action: z.enum(["list", "get", "patterns"]),
        status: z
          .enum(["open", "answered", "withdrawn"])
          .optional()
          .describe("list, patterns: only the items in this state."),
        kind: z
          .union([z.enum(kinds), z.array(z.enum(kinds)).min(1)])
          .optional()
          .describe("list: one kind, or a list of kinds."),
        scope: z
          .enum(["live", "test"])
          .optional()
          .describe("list: live (the default) or test."),
        origin_id: z
          .string()
          .optional()
          .describe(
            "list, patterns: the producer's id, for example starter:areas.",
          ),
        eval_id: z
          .string()
          .optional()
          .describe(
            "list, patterns: the items Evals filed for one record (eval.id): a calibration session, a model call's check, a golden, a dataset.",
          ),
        workflow: z
          .string()
          .optional()
          .describe("list: the items of the workflow that asked."),
        run: z
          .string()
          .optional()
          .describe("list: the items of the run that asked."),
        key: z
          .union([z.string(), z.array(z.string()).min(1).max(100)])
          .optional()
          .describe(
            "list: the items filed under this producer key, or these keys (at most 100).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(REVIEWS_PAGE_MAX)
          .optional()
          .describe(
            "list: items per page, at most 5, 20 or 100 by detail (compact, standard, full) and by default that many, so the page comes back whole.",
          ),
        cursor: z
          .string()
          .optional()
          .describe("list: the next_cursor of the page before."),
        id: z
          .string()
          .optional()
          .describe("get: the item's id, rev_… (or the sg_… of a change)."),
        type: z
          .enum(["facts", "links", "ontology", "other"])
          .optional()
          .describe("patterns: only the patterns of this kind of suggestion."),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const reviews = scoped(client, args.graph).reviews;
      if (args.action === "list") {
        return runPage(
          client,
          "lbb_reviews.list",
          args.detail,
          pageLimit(args.detail, args.limit, REVIEWS_PAGE_MAX),
          (limit) =>
            reviews.list({
              status: args.status,
              kind: args.kind,
              scope: args.scope,
              originId: args.origin_id,
              workflow: args.workflow,
              run: args.run,
              key: args.key,
              evalId: args.eval_id,
              limit,
              cursor: args.cursor,
            }),
        );
      }
      const action = args.action;
      return run(client, `lbb_reviews.${action}`, args.detail, () => {
        switch (action) {
          case "get":
            if (!args.id) throw new Error("get requires id");
            return reviews.get(args.id);
          case "patterns":
            return reviews.patterns({
              status: args.status,
              originId: args.origin_id,
              type: args.type,
              evalId: args.eval_id,
            });
        }
      });
    },
  );

  host.register(
    "lbb_reviews_manage",
    {
      description: `File, answer, comment on or withdraw review items. Show the item to the user and answer only what the user decided. ${KINDS_TEXT} An answer that accepts or corrects a value item, or accepts a change item, commits facts or applies an ontology change (which can remove types and relations): the server reads the items and asks the person to approve first, with the count and the effect. Any other answer, such as the grade or choice of an item Evals filed, asks nothing. ${APPROVAL_TEXT} create files an item of kind value, choice, grade or answer (kind, title, question, and optionally subject, evidence, rationale, key, scope, facts, origin); the same key again updates it, and an answered item comes back unchanged. File an ontology change with lbb_configure action=suggest_ontology_change. answer records the person's answer (decision, with value for correct, option for choose, note). An item has one answer: the same answer again returns the item, another one answers 409 review_answered. revision is the revision the person saw; a later one answers 409 review_stale. answer_batch gives one answer to up to 500 ids. comment adds text to an item's discussion. withdraw takes back an item you filed, with a reason. Each write sends an idempotency key, and a retry after a network failure or a 5xx sends the same key, so the write happens once.`,
      inputSchema: {
        action: z.enum([
          "create",
          "answer",
          "answer_batch",
          "comment",
          "withdraw",
        ]),
        id: z
          .string()
          .optional()
          .describe("answer, comment, withdraw: the item's id (rev_…)."),
        ids: z
          .array(z.string())
          .min(1)
          .max(500)
          .optional()
          .describe("answer_batch: 1 to 500 item ids."),
        answer: reviewAnswerSchema
          .optional()
          .describe(
            "answer, answer_batch: the answer, { decision, value, option, note }.",
          ),
        revision: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("answer: the revision of the item the person saw."),
        text: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe("comment: the comment, 1 to 4,000 characters."),
        author: z.string().optional().describe("comment: who writes it."),
        reason: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe("withdraw: why, at most 1,000 characters."),
        kind: z
          .enum(["value", "choice", "grade", "answer"])
          .optional()
          .describe("create: the kind of question."),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("create: the question in words, at most 200 characters."),
        question: questionSchema
          .optional()
          .describe("create: what the item asks, by kind."),
        subject: z
          .object({
            type: z.string().optional().describe("Its class"),
            name: z.string().optional().describe("Its display name"),
            key: z.string().optional().describe("Its stable import key"),
            iri: z.string().optional().describe("Its IRI"),
          })
          .strict()
          .optional()
          .describe("create: the record the question is about."),
        evidence: z
          .array(
            z
              .object({
                quote: z.string(),
                source_id: z
                  .string()
                  .nullish()
                  .describe(
                    "The Document IRI with a place (#page=3, #row=5), or a record's name",
                  ),
                confidence: z.number().min(0).max(1).nullish(),
                region: regionSchema.nullish(),
              })
              .passthrough(),
          )
          .optional()
          .describe("create: the quotes you read, and where they are."),
        evidence_hash: z
          .string()
          .max(128)
          .optional()
          .describe(
            "create: a mark of the evidence (a document version, a hash of the text). Asking again with other evidence and another proposal reopens an answered item.",
          ),
        facts: suggestedFactsSchema
          .optional()
          .describe(
            "create, a value item: the facts that accept or correct commits, as lbb_commit takes them (at most 200 triplets and property rows together).",
          ),
        key: z
          .string()
          .max(255)
          .optional()
          .describe(
            "create: your key for the item; the same key again updates it. Default: from the kind, subject and question.",
          ),
        origin: z
          .object({
            kind: z.enum(["integration", "agent", "person"]),
            id: z.string().optional(),
            label: z.string().optional(),
          })
          .strict()
          .optional()
          .describe(
            'create: the producer. Default {"kind": "agent", "id": "mcp agent"}.',
          ),
        rationale: z
          .string()
          .max(4000)
          .optional()
          .describe("create: why a person sees it, at most 4,000 characters."),
        scope: z
          .enum(["live", "test"])
          .optional()
          .describe("create: live (default) or test (writes nothing)."),
        workflow: z
          .object({
            name: z.string(),
            run: z.string().optional(),
            step: z.string().optional(),
            identity: z.string().optional(),
            turn: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional()
          .describe("create: the workflow run and step that asks."),
        eval: z
          .object({
            kind: z.enum(["check", "calibration", "test"]),
            id: z.string(),
          })
          .strict()
          .optional()
          .describe("create: the model check, calibration or test that asks."),
        wait: z
          .object({
            identity: z.string(),
            turn: z.number().int().nonnegative(),
          })
          .strict()
          .optional()
          .describe(
            "create: the engine identity and turn of a run that waits for the answer as the signal review.<id>.",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      // Accepting an item commits facts or applies an ontology change, which
      // can remove types and relations, so the tool may destroy.
      annotations: { ...MUTATING, destructiveHint: true },
    },
    async (args, extra) => {
      const decision = args.answer?.decision;
      if (
        (args.action === "answer" || args.action === "answer_batch") &&
        (decision === "accept" || decision === "correct")
      ) {
        const ids = [
          ...new Set(
            args.action === "answer"
              ? args.id
                ? [args.id]
                : []
              : (args.ids ?? []),
          ),
        ];
        const target = scoped(client, args.graph);
        let items: Schemas["ReviewItem"][];
        try {
          items = await mapLimit(ids, READS_AT_ONCE, (id) =>
            target.reviews.get(id),
          );
        } catch (error) {
          return errorResult(await enrichError(client, error));
        }
        const committing = items.filter(commits);
        if (committing.length) {
          const refused = await host.approve(extra, {
            message: async () => {
              const changes = new Map<string, ChangeDetail>();
              await mapLimit(
                committing.filter((item) => item.kind === "change"),
                READS_AT_ONCE,
                async (item) => {
                  try {
                    const suggestion = await target.ontology.suggestions.get(
                      item.suggestion_id ?? item.id.replace(/^rev_/, "sg_"),
                    );
                    changes.set(item.id, {
                      ops: suggestion.change ?? [],
                      facts: suggestion.facts,
                    });
                  } catch {
                    changes.set(item.id, undefined);
                  }
                },
              );
              return reviewAnswerMessage(
                graphLabel(client, args.graph),
                { decision, value: args.answer?.value },
                committing,
                changes,
                ids.length - committing.length,
              );
            },
          });
          if (refused) return refused;
        }
      }
      return run(
        client,
        `lbb_reviews_manage.${args.action}`,
        args.detail,
        () => {
          const target = scoped(client, args.graph);
          const opts = {
            idempotencyKey: target.idempotencyKey(`reviews.${args.action}`),
          };
          const id = () => {
            if (!args.id) throw new Error(`${args.action} requires id`);
            return args.id;
          };
          const answer = () => {
            if (!args.answer) throw new Error(`${args.action} requires answer`);
            return args.answer;
          };
          switch (args.action) {
            case "create": {
              if (!args.kind || !args.title || !args.question) {
                throw new Error("create requires kind, title and question");
              }
              const body: Schemas["ReviewItemCreateRequest"] = {
                kind: args.kind,
                title: args.title,
                question: args.question,
                origin: args.origin ?? MCP_ORIGIN,
                ...(args.subject ? { subject: args.subject } : {}),
                ...(args.evidence ? { evidence: args.evidence } : {}),
                ...(args.evidence_hash
                  ? { evidence_hash: args.evidence_hash }
                  : {}),
                ...(args.facts
                  ? { facts: suggestedFactsBody(args.facts) }
                  : {}),
                ...(args.key ? { key: args.key } : {}),
                ...(args.rationale ? { rationale: args.rationale } : {}),
                ...(args.scope ? { scope: args.scope } : {}),
                ...(args.workflow ? { workflow: args.workflow } : {}),
                ...(args.eval ? { eval: args.eval } : {}),
                ...(args.wait ? { wait: args.wait } : {}),
              };
              return target.reviews.create(body, opts);
            }
            case "answer":
              return target.reviews.answer(
                id(),
                {
                  answer: answer(),
                  ...(args.revision !== undefined
                    ? { revision: args.revision }
                    : {}),
                },
                opts,
              );
            case "answer_batch":
              if (!args.ids) throw new Error("answer_batch requires ids");
              return target.reviews.answerBatch(
                { ids: args.ids, answer: answer() },
                opts,
              );
            case "comment":
              if (!args.text) throw new Error("comment requires text");
              return target.reviews.comment(
                id(),
                {
                  text: args.text,
                  ...(args.author ? { author: args.author } : {}),
                },
                opts,
              );
            case "withdraw":
              if (!args.reason) throw new Error("withdraw requires reason");
              return target.reviews.withdraw(id(), args.reason, opts);
          }
        },
      );
    },
  );
}
