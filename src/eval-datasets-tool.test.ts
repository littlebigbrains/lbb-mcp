import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { LbbServerOptions } from "./query-observer.js";
import { connect, ok, sent, type Call } from "./test-support.js";

async function setup(reply: unknown) {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(reply);
  });
  return { client, calls, last: () => sent(calls.at(-1)!) };
}

const item = {
  name: "Sink 1",
  text: "Einbauspüle, Breite 450 mm",
  values: [
    {
      property: "width_cm",
      value: 45,
      stated: "450 mm",
      quote: "Breite 450 mm",
    },
  ],
  leave_out: [{ property: "depth_cm", value: null, reason: "Not stated." }],
  iri: "https://example.com/sink/1",
  case: "A width in mm.",
};

test("lbb_evals reads, exports and creates datasets and adds items", async () => {
  const { client, calls, last } = await setup({
    id: "ds_1",
    object: "eval_dataset",
  });
  try {
    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets", cursor: "c1", detail: "standard" },
    });
    assert.deepEqual(last(), {
      method: "GET",
      path: "/v1/evals/datasets",
      query: { graph: "g", limit: "20", cursor: "c1" },
      body: undefined,
      key: undefined,
    });
    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_get", id: "ds_1" },
    });
    assert.deepEqual(
      [last().method, last().path, last().query],
      ["GET", "/v1/evals/datasets/get", { graph: "g", id: "ds_1" }],
    );
    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_export", id: "ds_1" },
    });
    assert.deepEqual(
      [last().method, last().path, last().query],
      ["GET", "/v1/evals/datasets/export", { graph: "g", id: "ds_1" }],
    );

    const created = await client.callTool({
      name: "lbb_evals",
      arguments: {
        action: "datasets_create",
        name: "sinks",
        items: [item],
        install: {
          properties: { width_cm: "f64" },
          units: { width_cm: "cm" },
          context: "Tender documents",
        },
        about: ["Sinks of one tender."],
      },
    });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    let call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/evals/datasets");
    assert.deepEqual(call.body, {
      name: "sinks",
      kind: "values",
      items: [item],
      install: {
        properties: { width_cm: "f64" },
        units: { width_cm: "cm" },
        context: "Tender documents",
      },
      about: ["Sinks of one tender."],
    });
    assert.match(call.key ?? "", /^eval-datasets\.create:/);

    await client.callTool({
      name: "lbb_evals",
      arguments: {
        action: "datasets_create",
        name: "sinks from a test",
        kind: "values",
        source: { kind: "test", id: "wtest_1" },
      },
    });
    assert.deepEqual(last().body, {
      name: "sinks from a test",
      kind: "values",
      source: { kind: "test", id: "wtest_1" },
    });

    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_items", id: "ds_1", items: [item] },
    });
    call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/evals/datasets/items");
    assert.deepEqual(call.query, { graph: "g" });
    assert.deepEqual(call.body, { id: "ds_1", items: [item] });
    assert.match(call.key ?? "", /^eval-datasets\.items:/);

    const before = calls.length;
    for (const args of [
      { action: "datasets_get" },
      { action: "datasets_export" },
      { action: "datasets_create", items: [item] },
      { action: "datasets_create", name: "empty" },
      {
        action: "datasets_create",
        name: "x",
        source: { kind: "review", id: "r" },
      },
      { action: "datasets_items", id: "ds_1" },
      { action: "datasets_items", items: [item] },
      // A label is no example, and an example is no label.
      {
        action: "datasets_items",
        id: "ds_1",
        items: [{ id: "hit_1", valid: true }],
      },
      { action: "label", trace_id: "tr_1", items: [item] },
    ]) {
      const result = await client.callTool({
        name: "lbb_evals",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before, "no request for an incomplete call");

    // The labels of a trace still take items.
    await client.callTool({
      name: "lbb_evals",
      arguments: {
        action: "label",
        trace_id: "tr_1",
        items: [{ id: "hit_1", valid: true, note: "Right sink." }],
      },
    });
    assert.deepEqual((last().body as { items: unknown }).items, [
      { id: "hit_1", valid: true, note: "Right sink." },
    ]);
  } finally {
    await client.close();
  }
});

/**
 * A server whose fake fetch answers the dataset read and the delete, and a
 * client that answers each approval with `answer` (none: no elicitation).
 */
async function deleteSetup(
  answer?: ElicitResult,
  read = ok(sinks),
  options?: LbbServerOptions,
) {
  const calls: Call[] = [];
  const asked: ElicitRequest["params"][] = [];
  const client = await connect(
    async (input, init) => {
      calls.push({ input, init: init ?? {} });
      return (init?.method ?? "GET") === "GET"
        ? read
        : ok({ id: "ds_1", object: "eval_dataset", deleted: true });
    },
    options,
    answer
      ? (params) => {
          asked.push(params);
          return answer;
        }
      : undefined,
  );
  return { client, calls, asked };
}

const sinks = {
  id: "ds_1",
  object: "eval_dataset",
  name: "sinks",
  kind: "values",
  item_count: 12,
  created: "2026-10-21T10:00:00Z",
  items: [],
};

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (
    result.structuredContent as { error: { code: string; message: string } }
  ).error;
}

test("lbb_evals_delete names the dataset and its items, and deletes it once the person approves", async () => {
  const { client, calls, asked } = await deleteSetup({
    action: "accept",
    content: { confirm: true },
  });
  try {
    const result = await client.callTool({
      name: "lbb_evals_delete",
      arguments: { id: "ds_1", graph: "notes" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].mode, "form");
    assert.equal(
      asked[0].message,
      'Delete the dataset "sinks" (ds_1) of graph "notes" with its 12 items? The next save of its workflow test makes a new dataset.',
    );
    assert.deepEqual(
      calls.map((call) => {
        const { method, path, query } = sent(call);
        return [method, path, query];
      }),
      [
        ["GET", "/v1/evals/datasets/get", { graph: "notes", id: "ds_1" }],
        ["DELETE", "/v1/evals/datasets", { graph: "notes", id: "ds_1" }],
      ],
    );
    assert.match(sent(calls[1]).key ?? "", /^eval-datasets\.delete:/);
    assert.match(JSON.stringify(result.structuredContent), /"deleted":true/);
  } finally {
    await client.close();
  }

  // One item reads as one item.
  const one = await deleteSetup(
    { action: "decline" },
    ok({ ...sinks, item_count: 1 }),
  );
  try {
    await one.client.callTool({
      name: "lbb_evals_delete",
      arguments: { id: "ds_1" },
    });
    assert.match(one.asked[0].message, /of graph "g" with its 1 item\?/);
  } finally {
    await one.client.close();
  }
});

test("lbb_evals_delete sends no delete when the person declines or cancels", async () => {
  for (const answer of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { confirm: false } },
  ] as ElicitResult[]) {
    const { client, calls, asked } = await deleteSetup(answer);
    try {
      const result = await client.callTool({
        name: "lbb_evals_delete",
        arguments: { id: "ds_1" },
      });
      assert.equal(result.isError, true, JSON.stringify(answer));
      assert.equal(errorOf(result).code, "approval_declined");
      assert.equal(asked.length, 1);
      // The read that names the dataset, and nothing else.
      assert.deepEqual(
        calls.map((call) => sent(call).method),
        ["GET"],
      );
    } finally {
      await client.close();
    }
  }
});

test("lbb_evals_delete returns the read's 404 and asks nothing", async () => {
  const { client, calls, asked } = await deleteSetup(
    { action: "accept", content: { confirm: true } },
    {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: {
            type: "not_found_error",
            code: "not_found",
            message: "eval dataset ds_9 not found",
          },
        }),
    },
  );
  try {
    const result = await client.callTool({
      name: "lbb_evals_delete",
      arguments: { id: "ds_9" },
    });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error: { status: number } }).error.status,
      404,
    );
    assert.match(errorOf(result).message, /ds_9 not found/);
    assert.equal(asked.length, 0);
    assert.deepEqual(
      calls.map((call) => sent(call).method),
      ["GET"],
    );
  } finally {
    await client.close();
  }
});

test("lbb_evals_delete without elicitation is refused, unless the server allows it", async () => {
  const { client, calls } = await deleteSetup();
  try {
    // A confirm (as 0.15 callers send it) is no way through.
    for (const args of [{ id: "ds_1" }, { id: "ds_1", confirm: "ds_1" }]) {
      const result = await client.callTool({
        name: "lbb_evals_delete",
        arguments: args,
      });
      assert.equal(result.isError, true);
      assert.equal(errorOf(result).code, "approval_required");
    }
    assert.deepEqual(calls, [], "no request, not even the read");
  } finally {
    await client.close();
  }

  // LBB_MCP_DESTRUCTIVE=allow: nobody is asked, so the dataset is not read.
  const allowed = await deleteSetup(undefined, ok(sinks), {
    destructiveWithoutApproval: "allow",
  });
  try {
    const result = await allowed.client.callTool({
      name: "lbb_evals_delete",
      arguments: { id: "ds_1" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(
      allowed.calls.map((call) => {
        const { method, path, query } = sent(call);
        return [method, path, query];
      }),
      [["DELETE", "/v1/evals/datasets", { graph: "g", id: "ds_1" }]],
    );
  } finally {
    await allowed.client.close();
  }
});
