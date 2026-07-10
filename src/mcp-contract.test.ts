import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import * as publicApi from "./index.js";
import {
  canonicalize,
  connect,
  ok,
  payload,
  type Call,
} from "./test-support.js";

test("pins the programmatic MCP package entrypoint", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    "buildLbbServer",
    "createMcpHttpServer",
    "registerLbbTools",
  ]);
});

test("exposes the Little Big Brain tool belt with annotations", async () => {
  const client = await connect(async () => ok());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "lbb_ask",
    "lbb_branch",
    "lbb_commit",
    "lbb_configure",
    "lbb_decode",
    "lbb_ground",
    "lbb_index",
    "lbb_inspect",
    "lbb_observe",
    "lbb_query",
    "lbb_search",
  ]);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.lbb_search.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_inspect.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_query.annotations?.readOnlyHint, true);
  // The substrate grounding/reasoning tools are all read-only (they may call a
  // model, but they never mutate the graph).
  assert.equal(byName.lbb_ask.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_decode.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_ground.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_commit.annotations?.readOnlyHint, false);
  assert.equal(byName.lbb_commit.annotations?.idempotentHint, true);
  assert.equal(byName.lbb_configure.annotations?.readOnlyHint, false);
  assert.equal(byName.lbb_configure.annotations?.idempotentHint, undefined);
  assert.equal(byName.lbb_index.annotations?.readOnlyHint, false);
  assert.match(byName.lbb_search.description ?? "", /mode=search_feedback/);
  assert.match(byName.lbb_search.description ?? "", /good=3, partial=1, bad=0/);
  assert.match(
    byName.lbb_commit.description ?? "",
    /Feedback grades: 3=ideal\/good, 1=partial, 0=bad/,
  );
  // lbb_query teaches the SPARQL IRI scheme so an agent can write a valid query
  // without first reverse-engineering term IRIs from the ontology.
  assert.match(
    byName.lbb_query.description ?? "",
    /littlebigbrain\.com\/r\/NAME/,
  );
  assert.match(byName.lbb_query.description ?? "", /content-addressed/);
  await client.close();
});

test("pins the public MCP server identity and complete tool contract", async () => {
  const client = await connect(async () => ok());
  assert.deepEqual(client.getServerVersion(), {
    name: "lbb",
    version: "0.1.0",
  });

  const { tools } = await client.listTools();
  const contract = tools
    .map(
      ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
      }) => ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(contract)))
    .digest("hex");

  assert.equal(
    digest,
    "3c79f5024872720ae2116bae12b1cb702b537244caaa9276c88b7e31af74f3fe",
  );
  await client.close();
});

test("lbb_ask / lbb_decode / lbb_ground route the context-substrate surfaces", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const url = String(input);
    if (url.includes("/v1/ask"))
      return ok({
        mode: "resident_planner",
        answer: "user-db.",
        citations: [],
      });
    if (url.includes("/v1/decode")) {
      return ok({
        relation: "TOUCHES",
        mode: "forced",
        candidates: ["TOUCHES"],
        signature_forced: true,
      });
    }
    if (url.includes("/v1/search/suggest")) {
      return ok({
        suggestions: [
          {
            text: "TOUCHES",
            kind: "relation",
            score: 1,
            signature_forced: true,
          },
        ],
      });
    }
    if (url.includes("/v1/search/resolve-term"))
      return ok({
        matches: [{ text: "PullRequest", kind: "class", score: 0.8 }],
        method: "embedding",
      });
    if (url.includes("/v1/graph/groundability"))
      return ok({ recommendation: "narrow", forced_pct: 0.83 });
    return ok({});
  };
  const client = await connect(fetch);

  // lbb_ask -> POST /v1/ask with the question.
  const ask = await client.callTool({
    name: "lbb_ask",
    arguments: { question: "what stores identity data", top_k: 5 },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/ask\?/);
  assert.equal(
    JSON.parse(calls.at(-1)!.init.body ?? "{}").question,
    "what stores identity data",
  );
  assert.equal(
    (payload(ask).data as { mode: string }).mode,
    "resident_planner",
  );

  // The bitemporal cursor rides through to the ask body.
  await client.callTool({
    name: "lbb_ask",
    arguments: {
      question: "what stored identity data last month",
      as_of_commit_seq: 9,
    },
  });
  assert.equal(JSON.parse(calls.at(-1)!.init.body ?? "{}").as_of_commit_seq, 9);

  // lbb_decode -> POST /v1/decode with the nested source/target the API expects.
  const decode = await client.callTool({
    name: "lbb_decode",
    arguments: {
      source_name: "00428ce",
      source_type: "Commit",
      target_name: "lbb-graph-query",
      target_type: "Component",
    },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/decode\?/);
  const decodeBody = JSON.parse(calls.at(-1)!.init.body ?? "{}");
  assert.equal(decodeBody.source.name, "00428ce");
  assert.equal(decodeBody.source.type, "Commit");
  assert.equal(decodeBody.target.type, "Component");
  assert.equal(
    (payload(decode).data as { relation: string }).relation,
    "TOUCHES",
  );

  // lbb_ground action=complete -> POST /v1/search/suggest, narrowing context passed.
  await client.callTool({
    name: "lbb_ground",
    arguments: {
      action: "complete",
      prefix: "tou",
      src_type: "Commit",
      dst_type: "Component",
    },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/search\/suggest\?/);
  const suggestBody = JSON.parse(calls.at(-1)!.init.body ?? "{}");
  assert.equal(suggestBody.prefix, "tou");
  assert.equal(suggestBody.context.src_type, "Commit");
  assert.equal(suggestBody.context.dst_type, "Component");

  // lbb_ground action=resolve -> POST /v1/search/resolve-term.
  await client.callTool({
    name: "lbb_ground",
    arguments: { action: "resolve", text: "writes to" },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/search\/resolve-term\?/);
  assert.equal(JSON.parse(calls.at(-1)!.init.body ?? "{}").text, "writes to");

  // lbb_ground action=audit -> GET /v1/graph/groundability.
  await client.callTool({
    name: "lbb_ground",
    arguments: { action: "audit", sample: 32 },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/graph\/groundability/);
  assert.equal(calls.at(-1)!.init.method, "GET");

  await client.close();
});

test("dispatch tools advertise real object input schemas (regression: object args were stringified)", async () => {
  const client = await connect(async () => ok());
  const { tools } = await client.listTools();
  const schemaOf = (name: string) =>
    tools.find((tool) => tool.name === name)?.inputSchema as {
      type: string;
      properties: Record<
        string,
        { type?: string; enum?: string[]; properties?: Record<string, unknown> }
      >;
    };

  // lbb_inspect/lbb_query/lbb_configure dispatch on a discriminant, so their
  // schemas are z.discriminatedUnion. The MCP SDK only advertises a JSON Schema for
  // a ZodObject (it reads `.shape`); a union advertised an empty `properties: {}`,
  // which made clients stringify object-valued args (the schema_preview/publish
  // `ontology`/`shapes` sources, the structured-query `body`) so the server rejected
  // them as "Expected object, received string". Each tool must advertise a flattened
  // object schema with those object-valued fields typed as objects.
  const inspect = schemaOf("lbb_inspect");
  assert.equal(inspect.type, "object");
  assert.ok(
    Object.keys(inspect.properties).length > 1,
    "lbb_inspect must advertise real properties",
  );
  assert.ok(inspect.properties.action?.enum?.includes("schema_preview"));
  assert.equal(inspect.properties.ontology?.type, "object");
  assert.ok(
    inspect.properties.ontology?.properties?.source,
    "ontology source is advertised as an object field",
  );
  assert.equal(inspect.properties.shapes?.type, "object");

  const query = schemaOf("lbb_query");
  assert.ok(query.properties.mode?.enum?.includes("structured"));
  assert.equal(query.properties.body?.type, "object");

  const configure = schemaOf("lbb_configure");
  assert.ok(configure.properties.action?.enum?.includes("publish_schema"));
  assert.ok(configure.properties.action?.enum?.includes("evolve_ontology"));
  assert.equal(configure.properties.ontology?.type, "object");
  assert.equal(configure.properties.shapes?.type, "object");
  assert.ok(configure.properties.shapes?.properties?.source);
  assert.ok(
    configure.properties.preview_digest,
    "publish_schema fields are advertised",
  );
  assert.equal(
    configure.properties.ops?.type,
    "array",
    "evolve_ontology ops advertised as an array",
  );

  await client.close();
});

test("lbb_query documents the real structured FILTER shape with a runnable example", async () => {
  // Regression for the feedback that six calls were rejected walking the error
  // strings to a filter shape: the old doc described { filter, op, value }, which
  // the server rejects (`unknown variant filter, expected compare/and/or/not`).
  // The advertised `body` description must teach the real shape and enumerate the
  // operand/value wrappers so the first attempt parses.
  const client = await connect(async () => ok());
  const { tools } = await client.listTools();
  const query = tools.find((tool) => tool.name === "lbb_query")
    ?.inputSchema as {
    properties: Record<string, { description?: string }>;
  };
  const body = query.properties.body?.description ?? "";
  assert.ok(body.includes('"compare"'), "documents the compare filter variant");
  assert.ok(
    body.includes("eq | ne | lt | le | gt | ge"),
    "enumerates comparison ops as names, not symbols",
  );
  assert.ok(body.includes('"property"'), "documents the property operand term");
  assert.ok(body.includes('"value"'), "documents the value operand term");
  assert.ok(
    body.includes('"f64"') && body.includes('"str"'),
    "enumerates the typed value wrappers",
  );
  assert.ok(
    !body.includes("{ filter: { property"),
    "drops the wrong { filter: { property }, op, value } shape that the server rejects",
  );
  await client.close();
});
