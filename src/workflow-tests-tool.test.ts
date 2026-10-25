import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, ok, payload, sent, type Call } from "./test-support.js";

async function setup(reply: unknown = { id: "wtest_1", status: "queued" }) {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(reply);
  });
  return { client, calls, last: () => sent(calls.at(-1)!) };
}

test("lbb_workflows tests lists one page and tests_get reads one test", async () => {
  const page = {
    object: "list",
    data: [{ id: "wtest_1", status: "done" }],
    has_more: true,
    next_cursor: "c2",
  };
  const { client, last } = await setup(page);
  try {
    const result = await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "tests", name: "sinks", limit: 30, cursor: "c1" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(payload(result).data, page);
    assert.deepEqual(last(), {
      method: "GET",
      path: "/v1/workflows/named/tests",
      query: { graph: "g", name: "sinks", limit: "5", cursor: "c1" },
      body: undefined,
      key: undefined,
    });
    await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "tests", detail: "full", graph: "tender" },
    });
    assert.deepEqual(last().query, { graph: "tender", limit: "50" });

    await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "tests_get", id: "wtest_1" },
    });
    assert.deepEqual(last(), {
      method: "GET",
      path: "/v1/workflows/named/tests/get",
      query: { graph: "g", id: "wtest_1" },
      body: undefined,
      key: undefined,
    });
    const noId = await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "tests_get" },
    });
    assert.equal(noId.isError, true);
  } finally {
    await client.close();
  }
});

test("lbb_workflows_manage tests_create names a workflow or installs one", async () => {
  const { client, calls, last } = await setup();
  try {
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "tests_create", name: "sinks", sample: 6 },
    });
    let call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/workflows/named/tests");
    assert.deepEqual(call.query, { graph: "g" });
    assert.deepEqual(call.body, {
      name: "sinks",
      sample: 6,
    });
    assert.match(call.key ?? "", /^workflow-tests\.create:/);

    const haiku = {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "low",
    };
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "tests_create",
        name: "sinks",
        models: { extract: haiku },
      },
    });
    assert.deepEqual(last().body, {
      name: "sinks",
      models: { extract: haiku },
    });

    const install = {
      starter: "values.extract",
      name: "sinks",
      watch: { class: "Sink", fields: ["description"] },
      params: { properties: ["width_cm"], context: "Tender documents" },
      gate: { below: 0.8 },
    };
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "tests_create",
        install,
        iris: ["https://example.com/sink/1", "https://example.com/sink/2"],
        graph: "tender",
      },
    });
    call = last();
    assert.deepEqual(call.query, { graph: "tender" });
    assert.deepEqual(call.body, {
      install,
      iris: ["https://example.com/sink/1", "https://example.com/sink/2"],
    });

    const before = calls.length;
    for (const args of [
      { action: "tests_create" },
      { action: "tests_create", name: "sinks", install },
      { action: "tests_create", name: "sinks", sample: 21 },
      {
        action: "tests_create",
        install: {
          ...install,
          workflow: { workflow_type: "x", version: "v1" },
        },
      },
    ]) {
      const result = await client.callTool({
        name: "lbb_workflows_manage",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before, "no request for an incomplete call");
  } finally {
    await client.close();
  }
});

test("lbb_workflows_manage answers one value and cancels a test", async () => {
  const { client, calls, last } = await setup();
  try {
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "tests_answer",
        id: "wtest_1",
        iri: "https://example.com/sink/1",
        property: "width_cm",
        answer: { decision: "correct", value: 45 },
      },
    });
    let call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/workflows/named/tests/answer");
    assert.deepEqual(call.query, { graph: "g" });
    assert.deepEqual(call.body, {
      id: "wtest_1",
      iri: "https://example.com/sink/1",
      property: "width_cm",
      answer: { decision: "correct", value: 45 },
    });
    assert.match(call.key ?? "", /^workflow-tests\.answer:/);

    // null removes the answer.
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "tests_answer",
        id: "wtest_1",
        iri: "https://example.com/sink/1",
        property: "width_cm",
        answer: null,
      },
    });
    assert.equal((last().body as { answer: unknown }).answer, null);

    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "tests_cancel", id: "wtest_1" },
    });
    call = last();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/workflows/named/tests/cancel");
    assert.deepEqual(call.query, { graph: "g", id: "wtest_1" });
    assert.equal(call.body, undefined);

    const before = calls.length;
    for (const args of [
      { action: "tests_answer", iri: "i", property: "p", answer: null },
      { action: "tests_answer", id: "wtest_1", property: "p", answer: null },
      { action: "tests_answer", id: "wtest_1", iri: "i", answer: null },
      { action: "tests_answer", id: "wtest_1", iri: "i", property: "p" },
      { action: "tests_cancel" },
    ]) {
      const result = await client.callTool({
        name: "lbb_workflows_manage",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before, "no request for an incomplete call");
  } finally {
    await client.close();
  }
});
