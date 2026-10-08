import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, payload, type Call } from "./test-support.js";

function recorder(responses: unknown[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(responses.shift() ?? {});
  };
  return { fetch, calls };
}

type Notes = ReturnType<typeof payload> & { notes?: string[] };

const uri = (value: string) => ({ type: "uri", value });
const literal = (value: string) => ({ type: "literal", value });

test("lbb_query mode=names groups the candidates by name", async () => {
  const korn = {
    iri: "https://x.test/e/korn",
    label: "David Korn",
    class: "https://x.test/class/Person",
    score: 1,
    by: "exact",
  };
  const document = {
    ...korn,
    iri: "https://x.test/e/doc-korn",
    class: "https://x.test/class/SourceDocument",
  };
  const { fetch, calls } = recorder([
    {
      candidates: [
        { text: "David Korn", ...korn },
        { text: "David Korn", ...document },
      ],
      index_ready: true,
      index_names: 8,
      commit_seq: 4,
      ms: 2,
    },
    { candidates: [], index_ready: false, commit_seq: 4, ms: 3000 },
  ]);
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "names",
        text: "Summarize David Korn's deals",
        limit: 3,
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(calls[0].input, "http://h/v1/query/names?graph=g");
    assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
      text: "Summarize David Korn's deals",
      limit: 3,
    });
    const body = payload(result) as Notes;
    assert.deepEqual(body.data, {
      names: [{ text: "David Korn", candidates: [korn, document] }],
      index_ready: true,
      commit_seq: 4,
    });
    assert.match(body.summary, /1 name, 2 candidates/);

    const cold = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "names", text: "David Korn" },
      }),
    ) as Notes;
    assert.match(cold.notes?.[0] ?? "", /still building/);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=describe returns the text, and the JSON at full detail", async () => {
  const described = {
    commit_seq: 4,
    partial: true,
    classes: [
      {
        iri: "https://x.test/class/Club",
        name: "c:Club",
        instances: 128,
        properties: [],
      },
    ],
    properties: [],
    statements: [],
    unknown: ["https://x.test/class/Nothing"],
    prefixes: { c: "https://x.test/class/" },
    text: 'Published commit 4.\n- c:Club (128)\n  properties (of 100 sampled): p:isActive="true"^^xsd:boolean 1\n',
    age_ms: 5,
  };
  const { fetch, calls } = recorder([described, described]);
  const client = await connect(fetch);
  try {
    const compact = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "describe", question: "Which clubs are active?" },
      }),
    ) as Notes;
    assert.equal(calls[0].input, "http://h/v1/query/describe?graph=g");
    assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
      question: "Which clubs are active?",
    });
    assert.deepEqual(compact.data, {
      commit_seq: 4,
      partial: true,
      text: described.text,
      unknown: described.unknown,
    });
    assert.match(compact.notes?.[0] ?? "", /still sampling/);
    assert.match(compact.notes?.[1] ?? "", /no class or property/);

    const full = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "describe",
          classes: ["https://x.test/class/Club"],
          detail: "full",
        },
      }),
    );
    assert.deepEqual(
      (full.data as { classes: unknown }).classes,
      described.classes,
    );
  } finally {
    await client.close();
  }
});

test("lbb_query mode=commit_at finds a date's commit or passes the note on", async () => {
  const { fetch, calls } = recorder([
    {
      moment: "2026-06-19T00:00:00Z",
      as_of_commit_seq: 5,
      committed_at: "2026-06-18T09:00:00Z",
      resolved_by: "commit_time",
    },
    {
      moment: "2026-05-21T00:00:00Z",
      first_commit_at: "2026-06-01T09:00:00Z",
      note: "The moment is before the graph's first commit (2026-06-01T09:00:00Z). The graph held nothing then.",
    },
  ]);
  const client = await connect(fetch);
  try {
    const found = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "commit_at", date: "2026-06-18" },
      }),
    ) as Notes;
    assert.equal(
      calls[0].input,
      "http://h/v1/graph/commit-at?graph=g&date=2026-06-18",
    );
    assert.equal(found.summary, "lbb_query.commit_at: commit 5");
    assert.match(found.notes?.[0] ?? "", /mode=sparql as_of_commit_seq=5/);
    const none = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "commit_at", date: "2026-05-20" },
      }),
    ) as Notes;
    assert.equal(none.summary, "lbb_query.commit_at: no commit");
    assert.match(none.notes?.[0] ?? "", /before the graph's first commit/);

    const both = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "commit_at" },
    });
    assert.equal(both.isError, true);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=compare shows lexical rows, the totals and the next page", async () => {
  const contact = (n: number) => uri(`https://x.test/e/c${n}`);
  const compared = {
    before: {
      as_of_commit_seq: 1,
      resolved_by: "commit_time",
      rows: 2900,
      total: 2900,
      complete: true,
      pages: 1,
      ms: 40,
    },
    after: {
      as_of_commit_seq: 2,
      resolved_by: "latest",
      rows: 2930,
      total: 2930,
      complete: true,
      pages: 1,
      ms: 41,
    },
    vars: ["c", "stage"],
    key: ["c"],
    added: [{ c: contact(3000), stage: literal("Lead") }],
    removed: [{ c: contact(2899), stage: literal("Lead") }],
    changed: Array.from({ length: 20 }, (_, n) => ({
      key: { c: contact(n) },
      before: [{ stage: literal("Lead") }],
      after: [{ stage: literal("Won") }],
    })),
    totals: { added: 50, removed: 20, changed: 300, unchanged: 2580 },
    offset: 0,
    next_cursor: "7b22",
    ms: 90,
  };
  const { fetch, calls } = recorder([compared]);
  const client = await connect(fetch);
  try {
    const args = {
      mode: "compare",
      query: "SELECT ?c ?stage WHERE { ?c <https://x.test/p/stage> ?stage }",
      before: { date: "2026-06-05" },
      key: ["c"],
    };
    const body = payload(
      await client.callTool({ name: "lbb_query", arguments: args }),
    ) as Notes;
    assert.equal(calls[0].input, "http://h/v1/query/compare?graph=g");
    assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
      query: args.query,
      before: args.before,
      key: ["c"],
      limit: 20,
    });
    const data = body.data as {
      totals: unknown;
      added: unknown[];
      changed: Array<{ key: unknown; before: unknown[]; after: unknown[] }>;
    };
    assert.deepEqual(data.totals, compared.totals);
    assert.deepEqual(data.added, [
      { c: "https://x.test/e/c3000", stage: "Lead" },
    ]);
    assert.deepEqual(data.changed[0], {
      key: { c: "https://x.test/e/c0" },
      before: [{ stage: "Lead" }],
      after: [{ stage: "Won" }],
    });
    assert.match(body.summary, /added 50, removed 20, changed 300/);
    assert.deepEqual(body.next, { ...args, limit: 20, compare_cursor: "7b22" });
    assert.match(
      body.notes?.[0] ?? "",
      /entries 1 to 20 of each list \(added: 50, removed: 20, changed: 300\)/,
    );
  } finally {
    await client.close();
  }
});

test("lbb_query mode=question keeps a comparison's totals and says when a list is cut", async () => {
  const contact = (n: number) => uri(`https://x.test/e/c${n}`);
  const rewrite = {
    route: { kind: "history", confidence: 1, by: "caller" },
    query: {
      sparql: "SELECT ?c ?stage WHERE { ?c <https://x.test/p/stage> ?stage }",
      entailment: "none",
    },
    history: {
      as_of_date: "2026-06-05",
      compare: true,
      as_of_commit_seq: 1,
      resolved_by: "commit_time",
      key: ["c"],
      added: Array.from({ length: 30 }, (_, n) => ({
        c: contact(3000 + n),
        stage: literal("Lead"),
      })),
      removed: [],
      changed: Array.from({ length: 25 }, (_, n) => ({
        key: { c: contact(n) },
        before: [{ stage: literal("Lead") }],
        after: [{ stage: literal("Won") }],
      })),
      totals: { added: 2903, removed: 0, changed: 25, unchanged: 10 },
    },
    rationale: "Each contact's stage at both points.",
    attempts: 1,
    grounding: {
      commit_seq: 2,
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
  };
  const { fetch } = recorder([rewrite]);
  const client = await connect(fetch);
  try {
    const body = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "question",
          question: "Who moved stage since 5 June?",
        },
      }),
    ) as Notes;
    const history = (body.data as { history: Record<string, unknown> }).history;
    assert.equal((history.added as unknown[]).length, 20);
    assert.equal((history.changed as unknown[]).length, 20);
    assert.deepEqual(history.totals, rewrite.history.totals);
    assert.deepEqual(history.shown, { added: 20, changed: 20 });
    const notes = (body.notes ?? []).join("\n");
    assert.match(notes, /paired by \?c/);
    assert.match(notes, /Totals: added 2903, removed 0, changed 25/);
    assert.match(notes, /at most 20 entries \(added: 2903, changed: 25/);
    assert.match(notes, /mode=compare/);
  } finally {
    await client.close();
  }
});
