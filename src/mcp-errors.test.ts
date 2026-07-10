import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok } from "./test-support.js";

test("LbbError fields survive the MCP error boundary", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 400,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "x-request-id" ? "req_header" : null,
    },
    text: async () =>
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "missing_idempotency_key",
          message: "missing Idempotency-Key header",
          param: "Idempotency-Key",
          request_id: null,
          doc_url:
            "https://docs.littlebigbrain.com/errors/missing_idempotency_key",
        },
      }),
  });
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "metadata" },
  });
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    error: {
      type: string;
      code: string;
      param: string;
      request_id: string;
      doc_url: string;
      status: number;
    };
  };
  assert.deepEqual(structured.error, {
    type: "invalid_request_error",
    code: "missing_idempotency_key",
    message: "missing Idempotency-Key header",
    param: "Idempotency-Key",
    request_id: "req_header",
    doc_url: "https://docs.littlebigbrain.com/errors/missing_idempotency_key",
    status: 400,
  });
  assert.match(
    (result.content as { type: string; text: string }[])[0].text,
    /missing_idempotency_key/,
  );
  await client.close();
});

test("a graph-not-found 404 is rewritten into an actionable message that lists real graphs", async () => {
  // The default-graph 404 surfaced only a raw object-storage key
  // (`not found: tenants/lbb-dev/graphs/main/branches/main/heads/current.json`),
  // which meant nothing unless you already knew the graph's real name. The MCP
  // layer must catch it, enumerate the tenant's graphs via GET /v1/graphs, and
  // tell the caller which graph to pass. The listing endpoint is tenant-scoped,
  // so it resolves even though the scoped default graph does not exist.
  let listedGraphs = 0;
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graphs")) {
      listedGraphs += 1;
      return ok({
        object: "list",
        data: [
          { graph_id: "vc_outreach", branches: ["main"] },
          { graph_id: "product_dev", branches: ["main", "staging"] },
        ],
        has_more: false,
      });
    }
    return {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: {
            type: "not_found_error",
            code: "not_found",
            message:
              "not found: tenants/lbb-dev/graphs/main/branches/main/heads/current.json",
            doc_url: "https://littlebigbrain.com/errors/not_found",
          },
        }),
    };
  };
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "metadata" },
  });
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    error: {
      message: string;
      code: string;
      type: string;
      status: number;
      doc_url: string;
    };
  };
  // Metadata carried through untouched, message rewritten.
  assert.equal(structured.error.status, 404);
  assert.equal(structured.error.code, "not_found");
  assert.equal(structured.error.type, "not_found_error");
  assert.equal(
    structured.error.doc_url,
    "https://littlebigbrain.com/errors/not_found",
  );
  assert.equal(
    listedGraphs,
    1,
    "enrichment consults GET /v1/graphs exactly once",
  );
  const message = structured.error.message;
  assert.match(message, /graph "main" was not found in this tenant/);
  assert.match(
    message,
    /Available graphs in this tenant: vc_outreach, product_dev/,
  );
  assert.match(
    message,
    /Pass an existing graph as the `graph` argument \(e\.g\. graph="vc_outreach"\)/,
  );
  // The raw object-storage key is gone from the primary message.
  assert.doesNotMatch(message, /heads\/current\.json/);
  await client.close();
});

test("a missing-branch 404 on an existing graph points at the real branches", async () => {
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graphs")) {
      return ok({
        object: "list",
        data: [{ graph_id: "vc_outreach", branches: ["main", "experiment"] }],
        has_more: false,
      });
    }
    return {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: {
            type: "not_found_error",
            code: "not_found",
            message:
              "not found: tenants/lbb-dev/graphs/vc_outreach/branches/dev/heads/current.json",
          },
        }),
    };
  };
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "metadata" },
  });
  const structured = result.structuredContent as { error: { message: string } };
  assert.match(
    structured.error.message,
    /branch "dev" was not found on graph "vc_outreach"/,
  );
  assert.match(structured.error.message, /Existing branches: main, experiment/);
  assert.match(
    structured.error.message,
    /Pass an existing branch as the `branch` argument/,
  );
  await client.close();
});

test("a non-graph 404 (e.g. an entity) passes through unchanged, without a graph listing", async () => {
  // The enrichment must be surgical: only the head-object key pattern triggers it.
  let listedGraphs = 0;
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graphs")) {
      listedGraphs += 1;
      return ok({ object: "list", data: [], has_more: false });
    }
    return {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: {
            type: "not_found_error",
            code: "not_found",
            message: "entity not found: Person/Nobody",
          },
        }),
    };
  };
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "entity", entity_type: "Person", name: "Nobody" },
  });
  const structured = result.structuredContent as { error: { message: string } };
  assert.equal(structured.error.message, "entity not found: Person/Nobody");
  assert.equal(
    listedGraphs,
    0,
    "a non-graph 404 must not trigger a graph listing",
  );
  await client.close();
});
