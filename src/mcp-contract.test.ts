import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import * as publicApi from "./index.js";
import { canonicalize, connect, ok, type Call } from "./test-support.js";

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
    "lbb_branch",
    "lbb_commit",
    "lbb_configure",
    "lbb_decode",
    "lbb_ground",
    "lbb_inspect",
    "lbb_models",
    "lbb_observe",
    "lbb_query",
    "lbb_search",
  ]);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.lbb_search.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_decode.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_models.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_inspect.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_query.annotations?.readOnlyHint, true);
  // Published-vocabulary completion is read-only.
  assert.equal(byName.lbb_ground.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_commit.annotations?.readOnlyHint, false);
  assert.equal(byName.lbb_commit.annotations?.idempotentHint, true);
  assert.equal(byName.lbb_configure.annotations?.readOnlyHint, false);
  assert.equal(byName.lbb_configure.annotations?.idempotentHint, undefined);
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
    "8a6610def3c118fb49c849040e4323f9724c2f4e81c30a38f5fdb536a93f88dc",
  );
  await client.close();
});

test("lbb_ground routes completion, resolution, and groundability", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const url = String(input);
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
    return ok({});
  };
  const client = await connect(fetch);

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

  await client.callTool({
    name: "lbb_ground",
    arguments: { action: "resolve", text: "touches" },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/search\/resolve-term\?/);

  await client.callTool({
    name: "lbb_ground",
    arguments: { action: "audit", sample: 25 },
  });
  assert.match(calls.at(-1)!.input, /\/v1\/graph\/groundability\?/);
  assert.match(calls.at(-1)!.input, /sample=25/);

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
  // which made clients stringify object-valued args (publish-schema
  // `ontology`/`shapes` sources and the structured-query `body`) so the server rejected
  // them as "Expected object, received string". Each tool must advertise a flattened
  // object schema with those object-valued fields typed as objects.
  const inspect = schemaOf("lbb_inspect");
  assert.equal(inspect.type, "object");
  assert.ok(
    Object.keys(inspect.properties).length > 1,
    "lbb_inspect must advertise real properties",
  );
  assert.ok(inspect.properties.action?.enum?.includes("ontology_search"));
  assert.ok(
    !inspect.properties.action?.enum?.includes("edges"),
    "lbb_inspect must not advertise the retired full edge-list action",
  );
  assert.ok(inspect.properties.action?.enum?.includes("schema"));
  assert.ok(!inspect.properties.action?.enum?.includes("schema_preview"));
  assert.ok(!inspect.properties.action?.enum?.includes("schema_audit"));

  const query = schemaOf("lbb_query");
  assert.ok(query.properties.mode?.enum?.includes("structured"));
  assert.equal(query.properties.body?.type, "object");

  const configure = schemaOf("lbb_configure");
  assert.ok(configure.properties.action?.enum?.includes("evolve_ontology"));
  assert.ok(
    configure.properties.action?.enum?.includes("publish_schema"),
    "atomic schema publication is advertised",
  );
  assert.equal(configure.properties.shapes?.type, "object");
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
