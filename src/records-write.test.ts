import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@littlebigbrain/client";
import { connect, ok, payload, sent, type Call } from "./test-support.js";
import { HARD_OUTPUT_CHARS } from "./tool-contracts.js";

const capability = { capabilities: ["records_commit_v1"] };
const approved: ElicitResult = { action: "accept", content: { confirm: true } };
function body(): Record<string, unknown> {
  return {
    version: "records/1",
    schema_revision: "original",
    owner: "ordinary-source",
    scope: "run:1",
    entities: [
      {
        id: "https://Example.org/雪",
        add: {
          "https://littlebigbrain.com/p/MixedCase": [
            { "@id": "https://Example.org/Target" },
            {
              "@value": "9007199254740993",
              "@type": "http://www.w3.org/2001/XMLSchema#integer",
            },
            {
              "@value": "1.0000000000000001",
              "@type": "http://www.w3.org/2001/XMLSchema#decimal",
            },
            { "@value": "Bonjour", "@language": "fr" },
            {
              "@value": "2026-10-26T10:00:00+02:00",
              "@type": "http://www.w3.org/2001/XMLSchema#dateTime",
            },
          ],
        },
      },
    ],
    relationships: [
      {
        id: "urn:claim",
        source: "https://Example.org/雪",
        type: "https://littlebigbrain.com/r/MixedCase",
        target: "urn:target",
        asserted: true,
        add: { "urn:evidence": { "@value": "original evidence" } },
      },
    ],
  };
}
function receipt() {
  return {
    object: "record_commit",
    version: "records/1",
    idempotent_replay: false,
    receipt: {
      epoch: "18446744073709551615",
      commit_seq: 7,
      visibility_token: "opaque-original",
      schema_revision: "original",
      scope: { owner: "ordinary-source", scope: "run:1" },
      resolved_ids: {
        entities: ["https://Example.org/雪"],
        relationships: ["urn:claim"],
      },
      no_op: false,
      projection: { added: 9, removed: 0 },
    },
  };
}
function recording(
  calls: Call[],
  value: unknown = receipt(),
  status = 200,
): FetchLike {
  return async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return new URL(input).pathname === "/version"
      ? ok(capability)
      : {
          ok: status >= 200 && status < 300,
          status,
          text: async () => JSON.stringify(value),
        };
  };
}
function error(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["callTool"]>>,
) {
  return (result.structuredContent as { error: Record<string, unknown> }).error;
}
const posts = (calls: Call[]) =>
  calls.filter((call) => call.init.method === "POST");

test("records mode forwards exact IRIs/terms/scope and returns the whole original receipt", async () => {
  const calls: Call[] = [];
  const client = await connect(recording(calls));
  try {
    const request = body();
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: request,
        graph: "other",
        expected_graph_epoch: "18446744073709551615",
        idempotency_key: "original-key",
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(payload(result).data, receipt());
    assert.deepEqual(sent(posts(calls)[0]), {
      method: "POST",
      path: "/v1/graph/commit",
      query: { graph: "other", expected_graph_epoch: "18446744073709551615" },
      body: request,
      key: "original-key",
    });
    assert.equal(
      (result.structuredContent as { truncated?: boolean }).truncated,
      undefined,
    );
  } finally {
    await client.close();
  }
});

test("content-identical records use a stable key; body/epoch changes differ and explicit key wins", async () => {
  const calls: Call[] = [];
  const client = await connect(recording(calls));
  try {
    const original = body();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    for (const args of [
      { records: original },
      { records: reordered, graph: "g" },
      { records: original, expected_graph_epoch: "9" },
      { records: { ...original, scope: "other" } },
      { records: original, idempotency_key: "explicit" },
    ])
      await client.callTool({
        name: "lbb_commit",
        arguments: { mode: "records", ...args },
      });
    const keys = posts(calls).map((call) => sent(call).key);
    assert.match(keys[0]!, /^mcp\.commit:[0-9a-f]{64}$/);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.notEqual(keys[0], keys[3]);
    assert.equal(keys[4], "explicit");
  } finally {
    await client.close();
  }
});

test("explicit records mode and selector are required, and mixed empty legacy controls refuse before IO", async () => {
  const calls: Call[] = [];
  const client = await connect(recording(calls));
  try {
    for (const args of [
      { records: body() },
      { mode: "facts", records: body() },
      { mode: "records" },
      { mode: "records", records: { version: null } },
      { mode: "records", records: { version: "legacy" } },
      { mode: "records", records: body(), triplets: [] },
      { mode: "records", records: body(), entity_properties: [] },
      { mode: "records", records: body(), entity_embeddings: [] },
      { mode: "records", records: body(), retract_edges: [] },
      { mode: "records", records: body(), retract_entities: [] },
      { mode: "records", records: body(), dry_run: false },
      { mode: "records", records: body(), observed_at: "" },
      { mode: "records", records: body(), edge_idempotency: "append" },
      { mode: "facts", expected_graph_epoch: "9", triplets: [] },
    ]) {
      const result = await client.callTool({
        name: "lbb_commit",
        arguments: args,
      });
      assert.equal(result.isError, true);
    }
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
  }
});

test("unknown record fields are preserved for the server's strict refusal; owner policy stays server-owned", async () => {
  for (const [code, request, status] of [
    [
      "record_payload_invalid",
      { ...body(), future_unsupported: { raw: true } },
      400,
    ],
    ["owner_reserved", { ...body(), owner: "starter:internal" }, 403],
    ["rdf_mutation_not_enabled", body(), 400],
  ] as const) {
    const calls: Call[] = [];
    const client = await connect(
      recording(calls, { error: { code, message: "typed refusal" } }, status),
    );
    try {
      const result = await client.callTool({
        name: "lbb_commit",
        arguments: { mode: "records", records: request },
      });
      assert.equal(result.isError, true);
      assert.equal(error(result).code, code);
      assert.equal(posts(calls).length, 1);
      assert.deepEqual(sent(posts(calls)[0]).body, request);
    } finally {
      await client.close();
    }
  }
});

test("missing capability is GET-only and never falls back to legacy", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ capabilities: [] });
  });
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: { mode: "records", records: body() },
    });
    assert.equal(error(result).code, "record_capability_unavailable");
    assert.equal(posts(calls).length, 0);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].input).pathname, "/version");
  } finally {
    await client.close();
  }
});

const destructive = [
  { entities: [{ id: "urn:e", set: { "urn:p": [] } }] },
  { entities: [{ id: "urn:e", unset: ["urn:p"] }] },
  { entities: [{ id: "urn:e", remove: { "urn:p": "value" } }] },
  { entities: [{ id: "urn:e", delete: true }] },
  { relationships: [{ id: "urn:c", asserted: false }] },
  { relationships: [{ id: "urn:c", set: { "urn:evidence": "value" } }] },
  { relationships: [{ id: "urn:c", unset: ["urn:evidence"] }] },
  { relationships: [{ id: "urn:c", remove: { "urn:evidence": "value" } }] },
  { relationships: [{ id: "urn:c", delete: true }] },
  { replace_scope: true, entities: [], relationships: [] },
];

test("all record forms that may remove support keep existing destructive approval and send nothing without it", async () => {
  const calls: Call[] = [];
  const client = await connect(recording(calls));
  try {
    for (const change of destructive) {
      const result = await client.callTool({
        name: "lbb_commit",
        arguments: {
          mode: "records",
          records: { version: "records/1", ...change },
        },
      });
      assert.equal(error(result).code, "approval_required");
    }
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
  }
});

test("decline sends no request; approval preserves snapshot identity and names the selected source scope", async () => {
  const declinedCalls: Call[] = [];
  const declined = await connect(
    recording(declinedCalls),
    undefined,
    () => ({ action: "decline" }),
    { form: {} },
  );
  try {
    const result = await declined.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: { version: "records/1", ...destructive[0] },
      },
    });
    assert.equal(error(result).code, "approval_declined");
    assert.equal(declinedCalls.length, 0);
  } finally {
    await declined.close();
  }
  const calls: Call[] = [];
  const messages: string[] = [];
  const request = {
    version: "records/1",
    owner: "ordinary-source",
    scope: "scope:雪",
    ...destructive[0],
  };
  const expected = JSON.parse(JSON.stringify(request));
  const client = await connect(
    recording(calls),
    undefined,
    (params) => {
      messages.push("message" in params ? params.message : "");
      request.owner = "changed";
      return approved;
    },
    { form: {} },
  );
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: request,
        idempotency_key: "original",
      },
    });
    assert.equal(result.isError, undefined);
    assert.match(messages[0], /owner "ordinary-source", scope "scope:雪"/);
    assert.deepEqual(sent(posts(calls)[0]).body, expected);
    assert.equal(sent(posts(calls)[0]).key, "original");
  } finally {
    await client.close();
  }
});

test("existing destructive allow setting permits records without adding a body permission bypass", async () => {
  const calls: Call[] = [];
  const client = await connect(recording(calls), {
    destructiveWithoutApproval: "allow",
  });
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: { version: "records/1", replace_scope: true },
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(posts(calls).length, 1);
  } finally {
    await client.close();
  }
});

test("record retry and replay keep the exact key/body and original projection/resolved IDs", async () => {
  const calls: Call[] = [];
  const original = receipt();
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (new URL(input).pathname === "/version") return ok(capability);
    if (posts(calls).length === 1) throw new Error("lost reply");
    return ok({ ...original, idempotent_replay: true });
  });
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: body(),
        expected_graph_epoch: "9",
        idempotency_key: "original",
      },
    });
    assert.deepEqual(payload(result).data, {
      ...original,
      idempotent_replay: true,
    });
    assert.equal(posts(calls).length, 2);
    assert.deepEqual(sent(posts(calls)[0]), sent(posts(calls)[1]));
  } finally {
    await client.close();
  }
});

test("malformed or legacy successes are unknown with the original key after exactly one POST", async () => {
  for (const invalidJson of [false, true]) {
    const calls: Call[] = [];
    const client = await connect(async (input, init) => {
      calls.push({ input, init: init ?? {} });
      if (new URL(input).pathname === "/version") return ok(capability);
      return invalidJson
        ? { ok: true, status: 200, text: async () => "not json" }
        : ok({ commit_seq: 0 });
    });
    try {
      const result = await client.callTool({
        name: "lbb_commit",
        arguments: {
          mode: "records",
          records: body(),
          idempotency_key: "original",
        },
      });
      assert.equal(result.isError, true);
      assert.equal(error(result).code, "record_outcome_unknown");
      assert.equal(error(result).outcome, "unknown");
      assert.equal(error(result).idempotency_key, "original");
      assert.match(error(result).message as string, /may have committed/);
      assert.equal(posts(calls).length, 1);
    } finally {
      await client.close();
    }
  }
});

test("a near64KiB receipt is complete under80k with no generic output compaction", async () => {
  const complete = receipt();
  while (Buffer.byteLength(JSON.stringify(complete), "utf8") < 63_000) {
    complete.receipt.resolved_ids.entities.push(
      `urn:雪:${complete.receipt.resolved_ids.entities.length}:${"x".repeat(90)}`,
    );
  }
  assert.ok(Buffer.byteLength(JSON.stringify(complete), "utf8") <= 65_536);
  const calls: Call[] = [];
  const client = await connect(recording(calls, complete));
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: { mode: "records", records: body() },
    });
    const text = (result.content as { text: string }[])[0].text;
    assert.equal(result.isError, undefined);
    assert.ok(Buffer.byteLength(text, "utf8") <= HARD_OUTPUT_CHARS);
    assert.deepEqual(payload(result).data, complete);
    assert.equal(payload(result).truncated, undefined);
  } finally {
    await client.close();
  }
});

test("unexpected oversized postaccept output preserves known acceptance instead of a false mutation failure", async () => {
  const oversized = receipt();
  oversized.receipt.resolved_ids.entities = [`urn:${"x".repeat(81_000)}`];
  const calls: Call[] = [];
  const client = await connect(recording(calls, oversized));
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: body(),
        idempotency_key: "original",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(error(result).code, "record_accepted_output_limit");
    assert.equal(error(result).outcome, "accepted");
    assert.equal(error(result).idempotency_key, "original");
    assert.equal(error(result).commit_seq, 7);
    assert.equal(posts(calls).length, 1);
    assert.ok(
      Buffer.byteLength(
        (result.content as { text: string }[])[0].text,
        "utf8",
      ) <= HARD_OUTPUT_CHARS,
    );
  } finally {
    await client.close();
  }
});

test("records payload and recovery identity limits refuse before approval or API IO", async () => {
  const calls: Call[] = [];
  const client = await connect(recording(calls));
  try {
    for (const args of [
      {
        records: {
          version: "records/1",
          entities: [
            { id: "urn:e", set: { "urn:p": "x".repeat(1024 * 1024) } },
          ],
        },
      },
      { records: body(), idempotency_key: "x".repeat(8193) },
      {
        records: { version: "records/1", ...destructive[0] },
        idempotency_key: "",
      },
    ]) {
      const result = await client.callTool({
        name: "lbb_commit",
        arguments: { mode: "records", ...args },
      });
      assert.equal(result.isError, true);
      assert.notEqual(error(result).code, "approval_required");
    }
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
  }
});

for (const [maxRetries, attempts] of [
  [undefined, 7],
  [0, 1],
] as const) {
  test(`exhausted POST transport loss preserves derived key and unknown outcome (retries=${maxRetries ?? "default"})`, async () => {
    const calls: Call[] = [];
    const client = await connect(
      async (input, init) => {
        calls.push({ input, init: init ?? {} });
        if (new URL(input).pathname === "/version") return ok(capability);
        throw new Error("socket closed after request");
      },
      undefined,
      undefined,
      {},
      { maxRetries },
    );
    try {
      const result = await client.callTool({
        name: "lbb_commit",
        arguments: {
          mode: "records",
          records: body(),
        },
      });
      assert.equal(result.isError, true);
      assert.equal(error(result).code, "record_outcome_unknown");
      assert.equal(error(result).outcome, "unknown");
      assert.equal(posts(calls).length, attempts);
      assert.equal(error(result).idempotency_key, sent(posts(calls)[0]).key);
      assert.match(
        error(result).idempotency_key as string,
        /^mcp\.commit:[0-9a-f]{64}$/,
      );
      for (const call of posts(calls)) {
        assert.equal(sent(call).path, "/v1/graph/commit");
        assert.deepEqual(sent(call), sent(posts(calls)[0]));
      }
    } finally {
      await client.close();
    }
  });
}

test("capability GET transport failure is not a record unknown outcome and sends no POST", async () => {
  const calls: Call[] = [];
  const client = await connect(
    async (input, init) => {
      calls.push({ input, init: init ?? {} });
      throw new Error("capability endpoint offline");
    },
    undefined,
    undefined,
    {},
    { maxRetries: 0 },
  );
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: { mode: "records", records: body() },
    });
    assert.equal(result.isError, true);
    assert.equal(error(result).code, "tool_error");
    assert.equal(error(result).outcome, undefined);
    assert.equal(posts(calls).length, 0);
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
  }
});

test("oversized server error stays bounded while preserving typed refusal and recovery key", async () => {
  const calls: Call[] = [];
  const client = await connect(
    recording(
      calls,
      {
        error: {
          type: "invalid_request_error",
          code: "owner_reserved",
          message: "拒".repeat(40_000),
        },
      },
      403,
    ),
  );
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "records",
        records: body(),
        idempotency_key: "original",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(error(result).code, "owner_reserved");
    assert.equal(error(result).status, 403);
    assert.equal(error(result).idempotency_key, "original");
    assert.equal(error(result).message_truncated, true);
    assert.equal(error(result).outcome, undefined);
    assert.ok(
      Buffer.byteLength(
        (result.content as { text: string }[])[0].text,
        "utf8",
      ) <= HARD_OUTPUT_CHARS,
    );
    assert.equal(posts(calls).length, 1);
  } finally {
    await client.close();
  }
});

test("typed server500 keeps its original code/status and derived recovery key without inventing a verdict", async () => {
  const calls: Call[] = [];
  const client = await connect(
    recording(
      calls,
      {
        error: {
          type: "api_error",
          code: "api_error",
          message: "original storage outcome is unconfirmed",
        },
      },
      500,
    ),
    undefined,
    undefined,
    {},
    { maxRetries: 0 },
  );
  try {
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: { mode: "records", records: body() },
    });
    assert.equal(error(result).code, "api_error");
    assert.equal(error(result).status, 500);
    assert.equal(
      error(result).message,
      "original storage outcome is unconfirmed",
    );
    assert.equal(error(result).outcome, undefined);
    assert.equal(error(result).idempotency_key, sent(posts(calls)[0]).key);
    assert.equal(posts(calls).length, 1);
  } finally {
    await client.close();
  }
});
