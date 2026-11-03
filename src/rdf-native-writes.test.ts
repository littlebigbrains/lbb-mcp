import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FetchLike } from "@littlebigbrain/client";
import { connect, ok, type Call } from "./test-support.js";

// The bodies the server sends for a graph that stores RDF (every new graph).
// The Rust route test `rdf_native_client_writes` pins the same texts.
function refusal(operation: string) {
  return {
    ok: false,
    status: 400,
    text: async () =>
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "rdf_native_graph",
          message:
            `${operation} is not available on this graph: its truth is written by the ` +
            "RDF-native routes. Write RDF statements with POST /v1/graph/import/rdf, " +
            "`graph rdf bulk-load`, or SPARQL Update instead.",
          param: null,
          request_id: null,
          doc_url:
            "https://docs.littlebigbrain.com/sdks/errors/#rdf_native_graph",
        },
      }),
  };
}

/** A server whose graph stores RDF, as its two record routes answer. */
function nativeServer() {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const url = new URL(input);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.pathname === "/v1/graph/commit") {
      if (body.replace_owned === undefined)
        return refusal(
          url.searchParams.has("dry_run")
            ? "a triplet / property commit dry run"
            : "a triplet / property / observation commit",
        );
      return ok(
        url.searchParams.has("dry_run")
          ? { dry_run: true, op_count: 2 }
          : {
              commit_seq: 4,
              visibility_token: "v4",
              owned: {
                edges_retracted: 1,
                fields_removed: 2,
                entities_retracted: (body.replace_owned.retract_entities ?? [])
                  .length,
              },
            },
      );
    }
    if (url.pathname === "/v1/graph/retract") {
      if ((body.entities ?? []).length > 0)
        return refusal(
          "entity retract (use replace_owned.retract_entities for RDF entity cleanup)",
        );
      return ok({ commit_seq: 3, visibility_token: "v3", retracted_edges: 1 });
    }
    return ok({});
  };
  return { fetch, calls };
}

const triplets = [
  {
    source: { type: "Organization", name: "Acme" },
    relation: "HAS_CATEGORY",
    target: { type: "Category", name: "Fintech" },
  },
];

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { text: string }[])[0]!.text;
}

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (
    result.structuredContent as { error: { code: string; message: string } }
  ).error;
}

test("lbb_commit facts adds the facts to a graph that stores RDF", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: { graph: "crm", triplets },
  });
  assert.notEqual(result.isError, true, text(result));
  assert.equal(calls.length, 2);
  const [refused, sent] = calls.map((call) =>
    JSON.parse(call.init.body ?? "{}"),
  );
  assert.equal(refused.replace_owned, undefined);
  assert.deepEqual(sent.replace_owned, {
    subjects: [{ type: "Organization", name: "Acme" }],
    relations: [],
    properties: [],
  });
  assert.deepEqual(sent.triplets, triplets);
  // The same derived key on both requests: the refused one wrote nothing.
  assert.match(
    calls[1]!.init.headers?.["idempotency-key"] ?? "",
    /^mcp\.commit:[0-9a-f]{64}$/,
  );
  assert.equal(
    calls[1]!.init.headers?.["idempotency-key"],
    calls[0]!.init.headers?.["idempotency-key"],
  );
  assert.match(text(result), /"commit_seq": 4/);
  await client.close();
});

test("lbb_commit facts previews a dry run on a graph that stores RDF", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: { graph: "crm", triplets, dry_run: true },
  });
  assert.notEqual(result.isError, true, text(result));
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((call) => new URL(call.input).searchParams.has("dry_run")),
  );
  assert.match(text(result), /"dry_run": true/);
  await client.close();
});

test("lbb_commit refuses entity_embeddings on a graph that stores RDF, and says what to do", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: {
      graph: "crm",
      triplets,
      entity_embeddings: [
        {
          type: "Organization",
          name: "Acme",
          model_id: "mine",
          vector: [0.1, 0.2],
        },
      ],
    },
  });
  assert.equal(result.isError, true);
  const error = errorOf(result);
  assert.equal(error.code, "rdf_native_graph");
  assert.match(error.message, /lbb_embeddings_manage action=declare/);
  assert.match(error.message, /lbb_query mode=search/);
  assert.match(error.message, /Nothing was written/);
  // Only the refused request went out.
  assert.equal(calls.length, 1);
  await client.close();
});

test("lbb_commit retract of exact links works on a graph that stores RDF", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch, { destructiveWithoutApproval: "allow" });
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: { mode: "retract", graph: "crm", retract_edges: triplets },
  });
  assert.notEqual(result.isError, true, text(result));
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.input, /\/v1\/graph\/retract/);
  await client.close();
});

test("lbb_commit retract_entities needs purge_entity_properties on a graph that stores RDF", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch, { destructiveWithoutApproval: "allow" });
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "retract",
      graph: "crm",
      retract_entities: [{ type: "Person", name: "Garen" }],
    },
  });
  assert.equal(result.isError, true);
  const error = errorOf(result);
  assert.equal(error.code, "rdf_native_graph");
  assert.match(error.message, /purge_entity_properties: true/);
  assert.match(error.message, /Nothing was removed/);
  assert.equal(calls.length, 1);
  await client.close();
});

test("lbb_commit retract_entities with purge_entity_properties removes whole records", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch, { destructiveWithoutApproval: "allow" });
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "retract",
      graph: "crm",
      retract_entities: [{ type: "Person", name: "Garen" }],
      purge_entity_properties: true,
    },
  });
  assert.notEqual(result.isError, true, text(result));
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.input, /\/v1\/graph\/commit/);
  assert.deepEqual(JSON.parse(calls[1]!.init.body ?? "{}"), {
    replace_owned: {
      subjects: [],
      relations: [],
      properties: [],
      retract_entities: [{ type: "Person", name: "Garen" }],
    },
  });
  assert.match(text(result), /"purged_entities": 1/);
  await client.close();
});

test("the retract question says when the records lose their field values", async () => {
  const { fetch } = nativeServer();
  const asked: string[] = [];
  const client = await connect(fetch, undefined, (params) => {
    asked.push(params.message);
    return { action: "accept", content: { confirm: true } };
  });
  const record = [{ type: "Person", name: "Garen" }];
  await client.callTool({
    name: "lbb_commit",
    arguments: { mode: "retract", retract_entities: record },
  });
  await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "retract",
      retract_entities: record,
      purge_entity_properties: true,
    },
  });
  assert.match(asked[0]!, /^Retract every current link of 1 record from/);
  assert.match(
    asked[1]!,
    /^Retract every current link and field value of 1 record from/,
  );
  assert.match(
    asked[1]!,
    /- every current link and field value of Garen \(Person\)/,
  );
  // A neighbour left with nothing loses its type and label: the question says so.
  assert.match(
    asked[1]!,
    /a record that is left with no link and no field loses its type and label too/,
  );
  assert.doesNotMatch(asked[0]!, /loses its type and label/);
  await client.close();
});

test("lbb_commit refuses a link with confidence and no evidence on a graph that stores RDF", async () => {
  const { fetch, calls } = nativeServer();
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: {
      graph: "crm",
      triplets: [{ ...triplets[0]!, confidence: 0.4 }],
    },
  });
  assert.equal(result.isError, true);
  const error = errorOf(result);
  assert.equal(error.code, "rdf_native_graph");
  assert.match(error.message, /evidence/);
  assert.match(error.message, /Nothing was written/);
  // Only the refused plain request went out.
  assert.equal(calls.length, 1);
  await client.close();
});
