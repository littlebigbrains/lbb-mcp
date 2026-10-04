import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, payload, type Call } from "./test-support.js";

const SPARQL =
  "SELECT ?name WHERE { ?s a <https://littlebigbrain.com/class/service> ; <http://www.w3.org/2000/01/rdf-schema#label> ?name }";

function rewrite(overrides: Record<string, unknown> = {}) {
  return {
    route: {
      kind: "lookup",
      confidence: 0.92,
      by: "router",
      probabilities: { lookup: 0.92, search: 0.08 },
    },
    query: { sparql: SPARQL, entailment: "subclass" },
    rationale: "The question names services by a condition.",
    attempts: 1,
    grounding: {
      commit_seq: 7,
      classes: 3,
      properties: 5,
      embeddings: 0,
      age_ms: 10,
    },
    models: [],
    timings: {
      ground_ms: 1,
      route_ms: 2,
      rewrite_ms: 3,
      run_ms: 4,
      total_ms: 10,
    },
    ...overrides,
  };
}

function run(names: string[], page: Record<string, unknown> = {}) {
  return {
    results: JSON.stringify({
      head: { vars: ["name"] },
      results: {
        bindings: names.map((name) => ({
          name: { type: "literal", value: name },
        })),
      },
    }),
    row_page: {
      returned: names.length,
      total: names.length,
      offset: 0,
      limit: 20,
      has_more: false,
      ...page,
    },
    snapshot: { commit_seq: 9, compacted_seq: 9, served_at_seq: 9 },
    trace_id: "tr_1",
  };
}

function recorder(responses: unknown[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const next = responses.shift();
    if (next && typeof next === "object" && "status" in next) {
      const failure = next as { status: number; body: unknown };
      return {
        ok: false,
        status: failure.status,
        text: async () => JSON.stringify(failure.body),
      };
    }
    return ok(next ?? {});
  };
  return { fetch, calls };
}

test("lbb_query mode=question posts the question and returns the route, the query and the rows", async () => {
  const { fetch, calls } = recorder([
    rewrite({ result: run(["Auth Service", "Billing"]) }),
  ]);
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "question",
        question: "Which services exist?",
        context: "Services of the platform team.",
        route: "lookup",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(calls.length, 1, "a question reads no metadata first");
    assert.equal(calls[0].input, "http://h/v1/query/rewrite?graph=g");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
      question: "Which services exist?",
      context: "Services of the platform team.",
      route: "lookup",
      run: true,
      limit: 20,
    });

    const body = payload(result) as ReturnType<typeof payload> & {
      notes?: string[];
    };
    assert.match(
      body.summary,
      /^lbb_query\.question: route lookup \(router, confidence 0\.92\): returned 2 rows$/,
    );
    const data = body.data as {
      route: Record<string, unknown>;
      rationale: string;
      sparql: string;
      entailment: string;
      error: string | null;
      trace_id: string | null;
      attempts: number;
      results: { bindings: { name: { value: string } }[] };
    };
    assert.deepEqual(data.route, {
      kind: "lookup",
      confidence: 0.92,
      by: "router",
    });
    assert.equal(data.rationale, "The question names services by a condition.");
    assert.equal(data.sparql, SPARQL);
    assert.equal(data.entailment, "subclass");
    assert.equal(data.error, null);
    assert.equal(data.trace_id, "tr_1");
    assert.equal(data.attempts, 1);
    assert.deepEqual(
      data.results.bindings.map((row) => row.name.value),
      ["Auth Service", "Billing"],
    );
    assert.equal(body.row_page?.returned, 2);
    assert.equal(body.next, undefined);
    assert.match(body.notes?.[0] ?? "", /eval trace tr_1/);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=question bounds the rows and continues the query with mode=sparql", async () => {
  const names = Array.from(
    { length: 100 },
    (_, index) => `${index}:` + "x".repeat(2_000),
  );
  const { fetch, calls } = recorder([
    rewrite({
      result: run(names, {
        limit: 100,
        total: 250,
        has_more: true,
        next_offset: 100,
      }),
    }),
    {
      results: JSON.stringify({
        head: { vars: ["name"] },
        results: { bindings: [] },
      }),
      row_page: {
        returned: 0,
        total: 250,
        offset: 30,
        limit: 100,
        has_more: false,
      },
    },
  ]);
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "question",
        question: "Which services exist?",
        detail: "standard",
        graph: "other",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(
      Buffer.byteLength((result.content as { text: string }[])[0].text) <=
        80_000,
    );
    assert.equal(calls[0].input, "http://h/v1/query/rewrite?graph=other");
    assert.equal(JSON.parse(calls[0].init.body ?? "{}").limit, 100);
    const body = payload(result);
    const shown = (body.data as { results: { bindings: unknown[] } }).results
      .bindings.length;
    assert.ok(shown > 0 && shown < 100, `shown ${shown}`);
    assert.equal(body.truncated, true);
    assert.equal(body.next?.mode, "sparql");
    const cursor = JSON.parse(
      Buffer.from(body.next?.cursor as string, "base64url").toString("utf8"),
    );
    assert.equal(cursor.mode, "sparql");
    assert.equal(cursor.query, SPARQL);
    assert.equal(cursor.entailment, "subclass");
    assert.equal(cursor.graph, "other");
    assert.equal(cursor.offset, shown);
    assert.equal(cursor.as_of_commit_seq, 9, "the commit the run read");

    const next = await client.callTool({
      name: "lbb_query",
      arguments: body.next ?? {},
    });
    assert.notEqual(next.isError, true, JSON.stringify(next));
    assert.equal(
      calls[1].input,
      "http://h/v1/query/sparql-text?graph=other",
      "the continuation reads no metadata: the cursor holds the commit",
    );
    const sent = JSON.parse(calls[1].init.body ?? "{}");
    assert.equal(sent.query, SPARQL);
    assert.equal(sent.entailment, "subclass");
    assert.equal(sent.offset, shown);
    assert.equal(sent.as_of_commit_seq, 9);
    assert.equal(Object.hasOwn(sent, "request"), false);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=question run=false returns the whole query without rows", async () => {
  const longSparql = `${SPARQL} # ${"comment ".repeat(80)}`;
  const { fetch, calls } = recorder([
    rewrite({ query: { sparql: longSparql, entailment: "none" } }),
  ]);
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "question", question: "Which services?", run: false },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
      question: "Which services?",
      run: false,
    });
    const body = payload(result);
    assert.match(body.summary, /: the query, not run$/);
    const data = body.data as { sparql: string; trace_id: string | null };
    assert.equal(data.sparql, longSparql, "compact detail keeps the query");
    assert.equal(data.trace_id, null);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=question reports an ASK answer, a failed query and an unanswerable question", async () => {
  const { fetch } = recorder([
    rewrite({
      query: { sparql: "ASK { ?s ?p ?o }", entailment: "none" },
      result: {
        results: JSON.stringify({ head: {}, boolean: true }),
        row_page: {
          returned: 0,
          total: 0,
          offset: 0,
          limit: 20,
          has_more: false,
        },
      },
    }),
    rewrite({ attempts: 2, error: "unknown prefix ex" }),
    rewrite({
      route: { kind: "history", confidence: 0.81, by: "router" },
      history: { as_of_date: "2026-09-01", compare: false },
    }),
    rewrite({
      route: { kind: "unanswerable", confidence: 0.9, by: "rewriter" },
      query: null,
      rationale: "The graph holds no salaries.",
    }),
  ]);
  const client = await connect(fetch);
  try {
    const ask = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "question", question: "Is there any fact?" },
      }),
    );
    assert.match(ask.summary, /: ran the query$/);
    assert.equal((ask.data as { boolean: boolean }).boolean, true);

    const failed = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "question", question: "Which services exist?" },
      }),
    ) as ReturnType<typeof payload> & { notes?: string[] };
    assert.match(failed.summary, /: the query failed$/);
    assert.equal((failed.data as { error: string }).error, "unknown prefix ex");
    assert.match(failed.notes?.[0] ?? "", /mode=sparql/);

    const history = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "question", question: "Which services existed?" },
      }),
    ) as ReturnType<typeof payload> & { notes?: string[] };
    assert.deepEqual((history.data as { history: unknown }).history, {
      as_of_date: "2026-09-01",
      compare: false,
    });
    assert.match(history.notes?.[0] ?? "", /2026-09-01/);

    const none = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "question", question: "What does Ada earn?" },
      }),
    );
    assert.match(none.summary, /route unanswerable .*: no query$/);
    const data = none.data as { sparql: unknown; rationale: string };
    assert.equal(data.sparql, null);
    assert.equal(data.rationale, "The graph holds no salaries.");
  } finally {
    await client.close();
  }
});

test("lbb_query mode=question does not retry a failed call and checks its arguments first", async () => {
  const { fetch, calls } = recorder([
    {
      status: 503,
      body: {
        error: {
          type: "api_error",
          code: "rewrite_model_unavailable",
          message: "the query rewriter model did not answer; try again",
        },
      },
    },
  ]);
  const client = await connect(fetch);
  try {
    const failed = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "question", question: "Which services exist?" },
    });
    assert.equal(failed.isError, true);
    assert.equal(calls.length, 1, "a question spends model tokens: no retry");
    assert.match(
      (failed.content as { text: string }[])[0].text,
      /rewrite_model_unavailable/,
    );

    for (const args of [
      { mode: "question" },
      { mode: "question", question: "" },
      { mode: "question", question: "q", limit: 1_001 },
      { mode: "question", question: "q", route: "guess" },
      { mode: "question", question: "q", query: "ASK {}" },
    ]) {
      const refused = await client.callTool({
        name: "lbb_query",
        arguments: args,
      });
      assert.equal(refused.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, 1, "invalid arguments send no request");
  } finally {
    await client.close();
  }
});
