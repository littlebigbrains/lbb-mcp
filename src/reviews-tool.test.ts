import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, ok, payload, sent, type Call } from "./test-support.js";

const page = {
  object: "list",
  data: [{ id: "rev_1", object: "review_item", kind: "value" }],
  has_more: true,
  next_cursor: "c2",
};

async function setup(reply: unknown = page) {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(reply);
  });
  return { client, calls, last: () => sent(calls.at(-1)!) };
}

test("lbb_reviews list returns the page as the server sends it, with every filter", async () => {
  const { client, calls, last } = await setup();
  try {
    const result = await client.callTool({
      name: "lbb_reviews",
      arguments: {
        action: "list",
        status: "open",
        kind: ["value", "choice"],
        scope: "test",
        origin_id: "starter:areas",
        workflow: "areas",
        run: "run_1",
        key: ["k1", "k2"],
        limit: 10,
        cursor: "c1",
        detail: "standard",
        graph: "tender",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(payload(result).data, page);
    assert.deepEqual(last(), {
      method: "GET",
      path: "/v1/reviews",
      query: {
        graph: "tender",
        status: "open",
        kind: "value,choice",
        scope: "test",
        origin_id: "starter:areas",
        workflow: "areas",
        run: "run_1",
        limit: "10",
        cursor: "c1",
        key: "k1,k2",
      },
      body: undefined,
      key: undefined,
    });

    // One kind, and a page no larger than the detail shows.
    await client.callTool({
      name: "lbb_reviews",
      arguments: { action: "list", kind: "grade", limit: 50 },
    });
    assert.deepEqual(last().query, { graph: "g", kind: "grade", limit: "5" });
    await client.callTool({
      name: "lbb_reviews",
      arguments: { action: "list", detail: "full" },
    });
    assert.equal(last().query.limit, "100");
    assert.equal(calls.length, 3);
  } finally {
    await client.close();
  }
});

test("lbb_reviews get and patterns read one item and the patterns", async () => {
  const { client, calls, last } = await setup({ id: "rev_1" });
  try {
    await client.callTool({
      name: "lbb_reviews",
      arguments: { action: "get", id: "rev_1" },
    });
    // The client reads one item at `/v1/reviews/get`, or at its earlier
    // name `/v1/reviews/detail`; the server answers both.
    const read = last();
    assert.match(read.path, /^\/v1\/reviews\/(get|detail)$/);
    assert.deepEqual(
      { ...read, path: undefined },
      {
        method: "GET",
        path: undefined,
        query: { graph: "g", id: "rev_1" },
        body: undefined,
        key: undefined,
      },
    );
    await client.callTool({
      name: "lbb_reviews",
      arguments: {
        action: "patterns",
        status: "open",
        origin_id: "fit:interviews",
        type: "facts",
      },
    });
    assert.deepEqual(last(), {
      method: "GET",
      path: "/v1/reviews/patterns",
      query: {
        graph: "g",
        status: "open",
        origin_id: "fit:interviews",
        type: "facts",
      },
      body: undefined,
      key: undefined,
    });
    const before = calls.length;
    const noId = await client.callTool({
      name: "lbb_reviews",
      arguments: { action: "get" },
    });
    assert.equal(noId.isError, true);
    assert.equal(calls.length, before, "no request without id");
  } finally {
    await client.close();
  }
});

test("lbb_reviews_manage create files an item with an idempotency key", async () => {
  const { client, last } = await setup({ id: "rev_1" });
  try {
    const result = await client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "create",
        kind: "value",
        title: "Is the area of R 1.04 12.5 m2?",
        subject: { type: "Room", name: "R 1.04" },
        question: {
          property: "area",
          value: 12.5,
          unit: "m2",
          confidence: 0.62,
        },
        evidence: [
          {
            quote: "Fläche 12,5 m²",
            source_id: "https://example.com/plan.pdf#page=3",
            region: {
              page: 2,
              x0: 0.1,
              y0: 0.2,
              x1: 0.3,
              y1: 0.25,
              confidence: 0.9,
            },
          },
        ],
        evidence_hash: "h1",
        key: "rooms:R 1.04:area",
        rationale: "The plan states it.",
        scope: "test",
        graph: "tender",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/reviews");
    assert.deepEqual(call.query, { graph: "tender" });
    assert.match(call.key ?? "", /^reviews\.create:/);
    assert.deepEqual(call.body, {
      kind: "value",
      title: "Is the area of R 1.04 12.5 m2?",
      question: { property: "area", value: 12.5, unit: "m2", confidence: 0.62 },
      origin: { kind: "agent", id: "mcp agent", label: "mcp agent" },
      subject: { type: "Room", name: "R 1.04" },
      evidence: [
        {
          quote: "Fläche 12,5 m²",
          source_id: "https://example.com/plan.pdf#page=3",
          region: {
            page: 2,
            x0: 0.1,
            y0: 0.2,
            x1: 0.3,
            y1: 0.25,
            confidence: 0.9,
          },
        },
      ],
      evidence_hash: "h1",
      key: "rooms:R 1.04:area",
      rationale: "The plan states it.",
      scope: "test",
    });

    // A choice item with its own origin, a workflow, an eval and a wait.
    await client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "create",
        kind: "choice",
        title: "Which floor?",
        question: {
          options: [
            { id: "eg", label: "Ground floor" },
            { id: "og1", label: "First floor" },
          ],
          proposed: "eg",
        },
        origin: { kind: "integration", id: "conn_1", label: "Drive" },
        workflow: { name: "floors", run: "run_1", step: "pick" },
        eval: { kind: "test", id: "wtest_1" },
        wait: { identity: "floors.1", turn: 4 },
      },
    });
    const choice = last().body as Record<string, unknown>;
    assert.deepEqual(choice.origin, {
      kind: "integration",
      id: "conn_1",
      label: "Drive",
    });
    assert.deepEqual(choice.workflow, {
      name: "floors",
      run: "run_1",
      step: "pick",
    });
    assert.deepEqual(choice.eval, { kind: "test", id: "wtest_1" });
    assert.deepEqual(choice.wait, { identity: "floors.1", turn: 4 });

    const incomplete = await client.callTool({
      name: "lbb_reviews_manage",
      arguments: { action: "create", kind: "value", title: "No question" },
    });
    assert.equal(incomplete.isError, true);
  } finally {
    await client.close();
  }
});

test("lbb_reviews_manage answers, comments and withdraws with idempotency keys", async () => {
  const { client, calls, last } = await setup({ id: "rev_1" });
  try {
    await client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer",
        id: "rev_1",
        answer: {
          decision: "correct",
          value: 45,
          note: "The plan says 45 cm.",
        },
        revision: 3,
      },
    });
    let call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/reviews/answer");
    assert.deepEqual(call.query, { graph: "g", id: "rev_1" });
    assert.deepEqual(call.body, {
      answer: { decision: "correct", value: 45, note: "The plan says 45 cm." },
      revision: 3,
    });
    assert.match(call.key ?? "", /^reviews\.answer:/);

    await client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer_batch",
        ids: ["rev_1", "rev_2"],
        answer: { decision: "accept" },
      },
    });
    call = last();
    assert.equal(call.path, "/v1/reviews/answer-batch");
    assert.deepEqual(call.query, { graph: "g" });
    assert.deepEqual(call.body, {
      ids: ["rev_1", "rev_2"],
      answer: { decision: "accept" },
    });
    assert.match(call.key ?? "", /^reviews\.answer_batch:/);

    await client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "comment",
        id: "rev_1",
        text: "Checked against the plan.",
        author: "ada",
      },
    });
    call = last();
    assert.equal(call.path, "/v1/reviews/comment");
    assert.deepEqual(call.query, { graph: "g", id: "rev_1" });
    assert.deepEqual(call.body, {
      text: "Checked against the plan.",
      author: "ada",
    });
    assert.match(call.key ?? "", /^reviews\.comment:/);

    await client.callTool({
      name: "lbb_reviews_manage",
      arguments: { action: "withdraw", id: "rev_1", reason: "Asked twice." },
    });
    call = last();
    assert.equal(call.path, "/v1/reviews/withdraw");
    assert.deepEqual(call.query, { graph: "g", id: "rev_1" });
    assert.deepEqual(call.body, { reason: "Asked twice." });
    assert.match(call.key ?? "", /^reviews\.withdraw:/);

    // Each write has its own key. (An accept or a correct reads its items
    // first; these items commit nothing, so nobody is asked.)
    const keys = calls
      .filter((each) => sent(each).method === "POST")
      .map((each) => sent(each).key);
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, keys.length);

    const before = calls.length;
    for (const args of [
      { action: "answer", answer: { decision: "accept" } },
      { action: "answer", id: "rev_1" },
      { action: "answer_batch", answer: { decision: "accept" } },
      { action: "comment", id: "rev_1" },
      { action: "withdraw", id: "rev_1" },
      { action: "answer", id: "rev_1", answer: { decision: "maybe" } },
    ]) {
      const result = await client.callTool({
        name: "lbb_reviews_manage",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before, "no request for an incomplete call");
  } finally {
    await client.close();
  }
});

test("a retried answer keeps its idempotency key", async () => {
  const calls: Call[] = [];
  let posts = 0;
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (init?.method !== "POST") return ok({ id: "rev_1", kind: "choice" });
    posts += 1;
    return posts === 1
      ? { ok: false, status: 503, text: async () => "{}" }
      : ok({ id: "rev_1" });
  });
  try {
    const result = await client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer",
        id: "rev_1",
        answer: { decision: "accept" },
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const writes = calls.filter((call) => sent(call).method === "POST");
    assert.equal(writes.length, 2);
    const [first, second] = writes.map((call) => sent(call).key);
    assert.match(first ?? "", /^reviews\.answer:/);
    assert.equal(second, first);
  } finally {
    await client.close();
  }
});

/** A fake list route: `limit` items from the position `cursor` names. */
async function pagingSetup(itemOf: (n: number) => Record<string, unknown>) {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const url = new URL(input);
    const from = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit"));
    return ok({
      object: "list",
      data: Array.from({ length: limit }, (_, i) => itemOf(from + i)),
      has_more: true,
      next_cursor: String(from + limit),
    });
  });
  return { client, calls };
}

test("a list page over 80,000 characters is asked again for the items that fit", async () => {
  const { client, calls } = await pagingSetup((n) => ({
    id: `rev_${n}`,
    object: "review_item",
    kind: "value",
    rationale: "x".repeat(4_900),
  }));
  try {
    const result = await client.callTool({
      name: "lbb_reviews",
      arguments: { action: "list", detail: "full", cursor: "100" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const [first, second] = calls.map((call) => sent(call).query);
    assert.equal(calls.length, 2);
    assert.equal(first.limit, "100");
    const shown = Number(second.limit);
    assert.ok(shown > 3 && shown < 100, String(shown));
    assert.equal(second.cursor, "100", "the same position");
    const text = (result.content as { text: string }[])[0].text;
    assert.ok(text.length <= 80_000, String(text.length));
    const page = payload(result).data as {
      data: { id: string; rationale: string }[];
      next_cursor: string;
    };
    // Every item shown whole, and the cursor continues after the last one.
    assert.equal(page.data.length, shown);
    assert.ok(page.data.every((item) => item.rationale.length === 4_900));
    assert.equal(page.data.at(-1)?.id, `rev_${100 + shown - 1}`);
    assert.equal(page.next_cursor, String(100 + shown));
  } finally {
    await client.close();
  }
});

test("a list page keeps its next_cursor whole at every detail level", async () => {
  const long = "c".repeat(400);
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      object: "list",
      data: [{ id: "rev_1" }],
      has_more: true,
      next_cursor: long,
    });
  });
  try {
    for (const [name, args] of [
      ["lbb_reviews", { action: "list" }],
      ["lbb_workflows", { action: "queue", name: "notes" }],
      ["lbb_workflows", { action: "tests" }],
      ["lbb_evals", { action: "datasets" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const page = payload(result).data as { next_cursor: string };
      assert.equal(page.next_cursor, long, name);
      // Compact detail asks for the 5 items it shows.
      assert.equal(sent(calls.at(-1)!).query.limit, "5", name);
    }
  } finally {
    await client.close();
  }
});
