import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, sent, type Call } from "./test-support.js";

const PROJECTS = "ns_" + "6".repeat(64);
const ACME = "ns_" + "5".repeat(64);

function identity(id: string) {
  return { id, incarnation: "i", authority_revision: 1 };
}

/** A fake data plane: route-keyed answers, every request recorded. */
function plane(routes: Record<string, (call: Call) => unknown>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = { input: String(input), init: init as Call["init"] };
    calls.push(call);
    const { method, path } = sent(call);
    const answer = routes[`${method} ${path}`];
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return ok(answer(call));
  };
  return { fetch, calls };
}

function namespaceAnswer(rows: string[], selection = "sel-1") {
  return {
    results: JSON.stringify({
      head: { vars: ["g", "risk"] },
      results: {
        bindings: rows.map((risk, index) => ({
          g: {
            type: "uri",
            value: `urn:lbb:graph:${index % 2 ? "beta" : "alpha"}`,
          },
          risk: { type: "literal", value: risk },
        })),
      },
    }),
    namespace: identity(PROJECTS),
    selection_token: selection,
    coverage: { selected_graphs: 2, queried_graphs: 2, complete: true },
    sources: [
      { graph_id: "alpha", name: "urn:lbb:graph:alpha", graph_epoch: "0" },
      { graph_id: "beta", name: "urn:lbb:graph:beta", graph_epoch: "3" },
    ],
    charged_read_bytes: 100,
  };
}

function text(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["callTool"]>>,
) {
  return JSON.parse(
    (result.content as { type: string; text: string }[])[0].text,
  ) as Record<string, any>;
}

test("lbb_query mode=namespace resolves the path, sends no graph and pages by cursor", async () => {
  let selection = "sel-1";
  const { fetch, calls } = plane({
    "GET /v1/catalog/namespaces/resolve": () => ({
      identity: identity(PROJECTS),
      name: "projects",
    }),
    "POST /v1/query/namespace": () =>
      namespaceAnswer(
        ["Late supplier", "Budget overrun", "Scope creep"],
        selection,
      ),
  });
  const client = await connect(fetch);
  try {
    const query =
      "SELECT ?g ?risk WHERE { GRAPH ?g { ?r a <urn:Risk> ; <urn:name> ?risk } }";
    const first = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "namespace",
        namespace: "acme/projects",
        query,
        row_limit: 2,
      },
    });
    assert.notEqual(first.isError, true, JSON.stringify(first));
    const resolve = sent(calls[0]);
    assert.equal(resolve.query.path, "acme/projects");
    const posted = sent(calls[1]);
    assert.equal(posted.path, "/v1/query/namespace");
    assert.equal(
      posted.query.graph,
      undefined,
      "the namespace route owns its graph selection",
    );
    assert.deepEqual(posted.body, {
      namespace_id: PROJECTS,
      include_descendants: true,
      default_graph: "union",
      query,
    });
    const page = text(first);
    assert.deepEqual(page.namespace, { id: PROJECTS, path: "acme/projects" });
    assert.deepEqual(page.sources, [
      { graph: "alpha", graph_epoch: "0" },
      { graph: "beta", graph_epoch: "3" },
    ]);
    assert.deepEqual(page.rows, [
      { g: "urn:lbb:graph:alpha", risk: "Late supplier" },
      { g: "urn:lbb:graph:beta", risk: "Budget overrun" },
    ]);
    assert.deepEqual(page.row_page, {
      offset: 0,
      returned: 2,
      total: 3,
      has_more: true,
    });
    assert.equal(page.coverage.complete, true);

    const second = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "namespace", cursor: page.next.cursor },
    });
    assert.notEqual(second.isError, true, JSON.stringify(second));
    assert.equal(
      calls.length,
      3,
      "a continuation does not resolve the path again",
    );
    const next = text(second);
    assert.deepEqual(next.rows, [
      { g: "urn:lbb:graph:alpha", risk: "Scope creep" },
    ]);
    assert.equal(next.next, undefined);

    selection = "sel-2";
    const changed = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "namespace", cursor: page.next.cursor },
    });
    assert.equal(changed.isError, true);
    assert.match(JSON.stringify(changed.content), /selection changed/);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=namespace passes an id, direct ownership and an ASK result", async () => {
  const { fetch, calls } = plane({
    "POST /v1/query/namespace": () => ({
      ...namespaceAnswer([]),
      results: JSON.stringify({ head: {}, boolean: true }),
    }),
  });
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "namespace",
        namespace: ACME,
        include_descendants: false,
        default_graph: "empty",
        query: "ASK { GRAPH ?g { ?s ?p ?o } }",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(calls.length, 1, "an id needs no resolve call");
    assert.deepEqual(sent(calls[0]).body, {
      namespace_id: ACME,
      include_descendants: false,
      default_graph: "empty",
      query: "ASK { GRAPH ?g { ?s ?p ?o } }",
    });
    assert.equal(text(result).boolean, true);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=namespace refuses a malformed path and a graph argument before any request", async () => {
  const { fetch, calls } = plane({});
  const client = await connect(fetch);
  try {
    const bad = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "namespace",
        namespace: "Acme Projects",
        query: "ASK {}",
      },
    });
    assert.equal(bad.isError, true);
    const graph = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "namespace", graph: "alpha", query: "ASK {}" },
    });
    assert.equal(graph.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
  }
});

test("lbb_inspect action=namespaces lists child namespaces with paths and the graphs owned directly", async () => {
  const { fetch, calls } = plane({
    "GET /v1/catalog/namespaces/resolve": () => ({
      identity: identity(ACME),
      name: "acme",
    }),
    "GET /v1/catalog/namespace": () => ({
      identity: identity(ACME),
      name: "acme",
      external_key: "customer:acme",
    }),
    "GET /v1/catalog/namespaces": () => ({
      items: [{ identity: identity(PROJECTS), name: "projects" }],
      next_cursor: null,
    }),
    "GET /v1/catalog/graphs": () => ({
      items: [{ graph_id: "standards", owner: identity(ACME), state: "ready" }],
      next_cursor: "more",
    }),
  });
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_inspect",
      arguments: { action: "namespaces", namespace: "acme" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const body = text(result);
    assert.deepEqual(body.namespace, {
      id: ACME,
      path: "acme",
      name: "acme",
      external_key: "customer:acme",
    });
    assert.deepEqual(body.children, [
      { id: PROJECTS, name: "projects", path: "acme/projects" },
    ]);
    assert.deepEqual(body.graphs, [{ graph: "standards", state: "ready" }]);
    assert.deepEqual(body.more, { children: false, graphs: true });
    const children = sent(calls[2]);
    assert.equal(children.query.parent_id, ACME);
    const graphs = sent(calls[3]);
    assert.equal(graphs.query.owner_id, ACME);
    assert.equal(
      graphs.query.include_descendants,
      undefined,
      "direct ownership only",
    );
  } finally {
    await client.close();
  }
});

test("lbb_inspect action=namespaces defaults to the root without a resolve call", async () => {
  const { fetch, calls } = plane({
    "GET /v1/catalog/namespaces": () => ({
      items: [{ identity: identity(ACME), name: "acme" }],
    }),
    "GET /v1/catalog/graphs": () => ({ items: [] }),
  });
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_inspect",
      arguments: { action: "namespaces" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(text(result).children, [
      { id: ACME, name: "acme", path: "acme" },
    ]);
    assert.equal(sent(calls[0]).query.parent_id, "root");
    assert.equal(calls.length, 2);
  } finally {
    await client.close();
  }
});

test("lbb_query mode=namespace reports an unknown path as namespace_not_found", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 404,
    text: async () =>
      JSON.stringify({
        error: {
          type: "not_found_error",
          code: "graph_not_found",
          message: "graph 'main' does not exist for this tenant",
        },
      }),
  });
  const client = await connect(fetch);
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "namespace", namespace: "acme/nope", query: "ASK {}" },
    });
    assert.equal(result.isError, true);
    const body = JSON.stringify(result.content);
    assert.match(body, /namespace_not_found/);
    assert.match(body, /no namespace at path acme\/nope/);
  } finally {
    await client.close();
  }
});

test("a namespace cursor page keeps the namespace path", async () => {
  const { fetch } = plane({
    "GET /v1/catalog/namespaces/resolve": () => ({
      identity: identity(PROJECTS),
    }),
    "POST /v1/query/namespace": () => namespaceAnswer(["a", "b"]),
  });
  const client = await connect(fetch);
  try {
    const first = text(
      await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "namespace",
          namespace: "acme/projects",
          query: "SELECT ?g ?risk WHERE { GRAPH ?g { ?r <urn:name> ?risk } }",
          row_limit: 1,
        },
      }),
    );
    const second = text(
      await client.callTool({
        name: "lbb_query",
        arguments: { mode: "namespace", cursor: first.next.cursor },
      }),
    );
    assert.deepEqual(second.namespace, { id: PROJECTS, path: "acme/projects" });
  } finally {
    await client.close();
  }
});
