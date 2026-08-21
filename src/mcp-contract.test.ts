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
    "lbb_inspect",
    "lbb_models",
    "lbb_observe",
    "lbb_query",
  ]);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.lbb_models.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_inspect.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_query.annotations?.readOnlyHint, true);
  assert.equal(byName.lbb_commit.annotations?.readOnlyHint, false);
  assert.equal(byName.lbb_commit.annotations?.idempotentHint, true);
  assert.equal(byName.lbb_configure.annotations?.readOnlyHint, false);
  assert.equal(byName.lbb_configure.annotations?.idempotentHint, undefined);
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
    "c05bf8cbbacdbe8510f9f37bb8e3c01f9e6036823c762e366cc7bf2f95af00f9",
  );
  await client.close();
});

test("the retired retrieval tools are no longer registered", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({});
  };
  const client = await connect(fetch);

  const { tools } = await client.listTools();
  const registered = new Set(tools.map((tool) => tool.name));
  for (const name of ["lbb_search", "lbb_ground", "lbb_decode"]) {
    assert.equal(registered.has(name), false, `${name} must not be registered`);
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, `${name} must not be callable`);
  }
  assert.deepEqual(calls, [], "a retired tool must issue no HTTP request");

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
