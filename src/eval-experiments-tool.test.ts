import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, ok, sent, type Call } from "./test-support.js";

async function setup(reply: unknown) {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(reply);
  });
  return { client, calls, last: () => sent(calls.at(-1)!) };
}

const B = {
  model: {
    use: "extract",
    model: { provider: "mock", model: "mock-candidate" },
  },
};

test("lbb_evals lists, reads, estimates, starts and cancels experiments", async () => {
  const { client, calls, last } = await setup({
    id: "exp_1",
    object: "eval_experiment",
  });
  try {
    await client.callTool({
      name: "lbb_evals",
      arguments: {
        action: "experiments",
        workflow: "sinks",
        dataset: "ds_1",
        status: "done",
        cursor: "c1",
        detail: "standard",
      },
    });
    assert.deepEqual(last(), {
      method: "GET",
      path: "/v1/evals/experiments",
      query: {
        graph: "g",
        workflow: "sinks",
        dataset: "ds_1",
        status: "done",
        limit: "20",
        cursor: "c1",
      },
      body: undefined,
      key: undefined,
    });
    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "experiment", id: "exp_1" },
    });
    assert.deepEqual(
      [last().method, last().path, last().query],
      ["GET", "/v1/evals/experiments/get", { graph: "g", id: "exp_1" }],
    );

    const request = { workflow: "sinks", dataset: "ds_1", b: B };
    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "experiments_estimate", ...request, max_items: 6 },
    });
    assert.deepEqual(
      [last().method, last().path, last().body],
      ["POST", "/v1/evals/experiments/estimate", { ...request, max_items: 6 }],
    );
    const created = await client.callTool({
      name: "lbb_evals",
      arguments: {
        action: "experiments_create",
        ...request,
        max_cost_usd: 2.5,
      },
    });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    const call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/evals/experiments");
    assert.deepEqual(call.body, { ...request, max_cost_usd: 2.5 });
    assert.match(call.key ?? "", /^eval-experiments\.create:/);

    await client.callTool({
      name: "lbb_evals",
      arguments: { action: "experiments_cancel", id: "exp_1" },
    });
    assert.deepEqual(
      [last().method, last().path, last().query],
      ["POST", "/v1/evals/experiments/cancel", { graph: "g", id: "exp_1" }],
    );
    assert.match(last().key ?? "", /^eval-experiments\.cancel:/);

    // A revision as B.
    await client.callTool({
      name: "lbb_evals",
      arguments: {
        action: "experiments_create",
        workflow: "sinks",
        dataset: "ds_1",
        b: { revision: "wrev_1" },
      },
    });
    assert.deepEqual((last().body as { b: unknown }).b, {
      revision: "wrev_1",
    });

    const before = calls.length;
    for (const args of [
      { action: "experiment" },
      { action: "experiments_cancel" },
      { action: "experiments_estimate", workflow: "sinks", dataset: "ds_1" },
      { action: "experiments_create", workflow: "sinks", b: B },
      { action: "experiments_create", dataset: "ds_1", b: B },
      // Only the arm's own fields, and the numbers in range.
      {
        action: "experiments_create",
        workflow: "sinks",
        dataset: "ds_1",
        b: { revision: "wrev_1", other: 1 },
      },
      {
        action: "experiments_create",
        workflow: "sinks",
        dataset: "ds_1",
        b: B,
        max_items: 201,
      },
      {
        action: "experiments_create",
        workflow: "sinks",
        dataset: "ds_1",
        b: { model: { use: "embed", model: B.model.model } },
      },
    ]) {
      const result = await client.callTool({
        name: "lbb_evals",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before, "no request for an incomplete call");
  } finally {
    await client.close();
  }
});
