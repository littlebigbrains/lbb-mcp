import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, payload, type Call } from "./test-support.js";

test("lbb_configure reads and writes the graph's rewrite profile", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ version: 3, notes: "n", examples: [] });
  };
  const client = await connect(fetch);

  const read = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "get_rewrite_profile", graph: "crm" },
  });
  assert.notEqual(read.isError, true);
  assert.deepEqual(payload(read).data, {
    version: 3,
    notes: "n",
    examples: [],
  });
  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "set_rewrite_profile",
      graph: "crm",
      notes: "A deal's current stage is p:deal_stage.",
      examples: [
        {
          question: "My open deals",
          sparql: "SELECT ?d WHERE { ?d a <https://x.test/Deal> }",
        },
      ],
      expected_version: 2,
      dry_run: true,
    },
  });

  assert.match(calls[0].input, /\/v1\/query\/rewrite\/profile\?graph=crm$/);
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[1].input, /\/v1\/query\/rewrite\/profile\?/);
  assert.match(calls[1].input, /dry_run=true/);
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].init.body ?? "{}"), {
    notes: "A deal's current stage is p:deal_stage.",
    examples: [
      {
        question: "My open deals",
        sparql: "SELECT ?d WHERE { ?d a <https://x.test/Deal> }",
      },
    ],
    expected_version: 2,
  });
  await client.close();
});

test("lbb_configure set_rewrite_profile refuses more than 20 examples", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({});
  });
  const result = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "set_rewrite_profile",
      examples: Array.from({ length: 21 }, () => ({
        question: "q",
        sparql: "ASK {}",
      })),
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, "nothing is sent");
  await client.close();
});
