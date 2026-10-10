import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike, type Schemas } from "@littlebigbrain/client";
import { connect, ok, payload, type Call } from "./test-support.js";

test("SPARQL text requests match the API contract with default and explicit commit pins", async () => {
  // Pin the HTTP request keys against the generated API contract, including in
  // the standalone MCP repository where the monorepo's OpenAPI file is absent.
  const fields: Record<keyof Schemas["SparqlTextRequest"], true> = {
    query: true,
    as_of_commit_seq: true,
    limit: true,
    offset: true,
    cursor: true,
    entailment: true,
    reason: true,
    request: true,
    profile: true,
  };
  for (const commit of [undefined, 0, 7]) {
    const calls: Call[] = [];
    const client = await connect(async (input, init) => {
      calls.push({ input, init: init ?? {} });
      if (input.includes("/v1/graph/metadata"))
        return ok({ snapshot: { commit_seq: 9 } });
      const body = JSON.parse(init?.body ?? "{}");
      const unknown = Object.keys(body).filter(
        (key) => !Object.hasOwn(fields, key),
      );
      if (unknown.length)
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              error: { message: `unknown field ${unknown[0]}` },
            }),
        };
      return ok({ results: JSON.stringify({ head: {}, boolean: true }) });
    });
    try {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "sparql",
          query: "ASK {}",
          as_of_commit_seq: commit,
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(
        (payload(result).data as { boolean: boolean }).boolean,
        true,
      );
      const sent = JSON.parse(calls.at(-1)?.init.body ?? "{}");
      assert.equal(sent.as_of_commit_seq, commit ?? 9);
      assert.equal(Object.hasOwn(sent, "as_of_valid_time"), false);
      assert.equal(calls.length, commit === undefined ? 2 : 1);
    } finally {
      await client.close();
    }
  }
});

test("SPARQL text rejects explicit and cursor valid-time pins before HTTP", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ snapshot: { commit_seq: 9 }, results: "{}" });
  });
  const cursor = (as_of: unknown) =>
    Buffer.from(
      JSON.stringify({
        v: 1,
        mode: "sparql",
        detail: "compact",
        row_limit: 20,
        offset: 20,
        query: "SELECT * WHERE { ?s ?p ?o }",
        as_of_commit_seq: 7,
        as_of,
      }),
    ).toString("base64url");
  try {
    for (const selector of [
      { as_of: "2026-09-12T00:00:00Z" },
      { as_of: "" },
      { cursor: cursor("2026-09-12T00:00:00Z") },
      { cursor: cursor(null) },
    ]) {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "sparql",
          query: "SELECT * WHERE { ?s ?p ?o }",
          ...selector,
        },
      });
      assert.equal(result.isError, true);
      assert.match(
        (result.content as { text: string }[])[0].text,
        /valid-time.*not supported.*as_of_commit_seq/,
      );
    }
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("lbb_models preserves published-root APIs", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({});
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_models",
    arguments: {
      action: "shadow_eval",
      body: { queries: [], challenger: {} },
    },
  });
  await client.callTool({
    name: "lbb_models",
    arguments: {
      action: "extractor_dataset",
      limit: 10,
      split_seq: 7,
    },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "schema", graph: "draft" },
  });

  assert.match(calls[0].input, /\/v1\/models\/shadow-eval\?/);
  assert.match(calls[1].input, /\/v1\/models\/extractor-dataset\?/);
  assert.match(calls[1].input, /limit=10/);
  assert.match(calls[1].input, /split_seq=7/);
  assert.match(calls[2].input, /\/v1\/schema\?/);
  assert.match(calls[2].input, /graph=draft/);
  await client.close();
});

test("lbb_models activity reads one month of the stack's model use", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      month: "2026-09",
      months: ["2026-09"],
      managed: [],
      totals: [],
      by_day: [],
      by_graph: [],
    });
  };
  const client = await connect(fetch);

  const september = await client.callTool({
    name: "lbb_models",
    arguments: { action: "activity", month: "2026-09" },
  });
  await client.callTool({
    name: "lbb_models",
    arguments: { action: "activity" },
  });
  const malformed = await client.callTool({
    name: "lbb_models",
    arguments: { action: "activity", month: "September" },
  });

  assert.notEqual(september.isError, true);
  assert.equal((payload(september).data as { month: string }).month, "2026-09");
  const [first, second] = calls.map((call) => new URL(call.input));
  assert.equal(first.pathname, "/v1/models/activity");
  assert.equal(first.searchParams.get("month"), "2026-09");
  assert.equal(second.searchParams.has("month"), false);
  assert.equal(malformed.isError, true);
  assert.equal(calls.length, 2, "a malformed month sends no request");
  await client.close();
});

test("lbb_evals reads the model checks summary and the checks of a graph", async () => {
  const summary: Schemas["ModelChecksSummary"] = {
    month: "2026-10",
    months: ["2026-10"],
    graph: "crm",
    jobs: [
      {
        job: "rerank",
        provider: "typesafe",
        model: "jev-latest",
        checks: 4,
        score: 0.75,
        right: 2,
        partly: 1,
        wrong: 1,
        reviewed: 1,
        corrected: 1,
      },
    ],
    judge: {
      provider: "anthropic",
      model: "claude-opus-5-5",
      reviewed: 2,
      overruled: 1,
      agreement: 0.5,
    },
    budget: {
      day: "2026-10-04",
      cost_micro_usd: 0,
      limit_micro_usd: 2_000_000,
      checks: 0,
    },
    checker_available: true,
    calls: 40,
  };
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return new URL(input).pathname.endsWith("/summary")
      ? ok(summary)
      : ok({ checks: [], next_after: "c0" });
  };
  const client = await connect(fetch);

  const month = await client.callTool({
    name: "lbb_evals",
    arguments: { action: "checks_summary", month: "2026-10", graph: "crm" },
  });
  const listed = await client.callTool({
    name: "lbb_evals",
    arguments: {
      action: "checks",
      job: "rerank",
      verdict: "wrong",
      reviewed: false,
      after: "c1",
      limit: 10,
    },
  });
  const malformed = await client.callTool({
    name: "lbb_evals",
    arguments: { action: "checks", month: "October" },
  });

  assert.notEqual(month.isError, true);
  assert.equal(
    (payload(month).data as Schemas["ModelChecksSummary"]).judge?.agreement,
    0.5,
  );
  assert.notEqual(listed.isError, true);
  assert.equal(
    (payload(listed).data as Schemas["ModelCheckListResponse"]).next_after,
    "c0",
  );
  const [first, second] = calls.map((call) => new URL(call.input));
  assert.equal(calls[0].init.method, "GET");
  assert.equal(first.pathname, "/v1/models/checks/summary");
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    graph: "crm",
    month: "2026-10",
  });
  assert.equal(second.pathname, "/v1/models/checks");
  assert.deepEqual(Object.fromEntries(second.searchParams), {
    graph: "g",
    job: "rerank",
    verdict: "wrong",
    reviewed: "false",
    after: "c1",
    limit: "10",
  });
  assert.equal(malformed.isError, true);
  assert.equal(calls.length, 2, "a malformed month sends no request");
  await client.close();
});

test("lbb_query sparql keeps the report of a search inside the query", async () => {
  const report = {
    plan: "search_first",
    top: 3,
    hits: 1,
    complete: false,
    candidates: 8192,
    rounds: 4,
    clusters_probed: 64,
    entries_considered: 9000,
    embeddings: ["service"],
    model_id: "openai/text-embedding-3-small",
    lag_commits: 0,
    timings: {
      resolve_ms: 0,
      embed_ms: 12,
      filter_ms: 30,
      index_ms: 4,
      rerank_ms: 1,
      check_ms: 0,
      total_ms: 47,
    },
    usage: { texts: 1, tokens_estimate: 3, cost_usd_estimate: 0 },
  };
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata")) {
      return ok({ snapshot: { commit_seq: 7 } });
    }
    if (input.includes("/v1/query/sparql-text")) {
      const body = JSON.parse(init?.body ?? "{}") as { query: string };
      const searched = body.query.includes("search:similarTo");
      return ok({
        results: JSON.stringify({
          head: { vars: ["x"] },
          results: { bindings: [{ x: { type: "uri", value: "x:1" } }] },
        }),
        row_page: {
          returned: 1,
          total: 1,
          offset: 0,
          limit: 20,
          has_more: false,
        },
        ...(searched ? { search: report } : {}),
      });
    }
    return ok({});
  };
  const client = await connect(fetch);

  const found = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "sparql",
      query:
        'PREFIX search: <https://littlebigbrain.com/search#> SELECT ?x WHERE { ?x search:similarTo "card payments" ; <https://littlebigbrain.com/r/calls> ?y } LIMIT 3',
    },
  });
  const plain = await client.callTool({
    name: "lbb_query",
    arguments: { mode: "sparql", query: "SELECT ?x WHERE { ?x ?p ?o }" },
  });

  const body = payload(found) as ReturnType<typeof payload> & {
    search?: typeof report;
    notes?: string[];
  };
  assert.deepEqual(body.search, report);
  assert.ok(
    body.notes?.some((note) => /bound 1 of the 3 hits/.test(note)),
    "an incomplete search is named in notes",
  );
  assert.equal("search" in payload(plain), false);
  await client.close();
});

test("lbb_inspect consolidates guide, ontology, metadata, and entity reads", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/summary")) {
      return ok({
        entity_count: 2,
        current_edge_count: 1,
        entity_types: [{ name: "Person", count: 2 }],
        relations: [{ name: "KNOWS", count: 1 }],
      });
    }
    return ok({ ok: true });
  };
  const client = await connect(fetch);

  const guide = await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "guide", detail: "full" },
  });
  assert.match(calls[0].input, /\/v1\/graph\/summary\?/);
  const guideBody = payload(guide).data as {
    capability: { search_feedback?: string; search?: string };
    how_to: string;
    possibilities: { run: { tool: string } }[];
  };
  assert.ok(guideBody.possibilities.every((p) => p.run.tool === "lbb_query"));
  // The search planning recipe: list, SPARQL on a sample, explain.
  assert.match(guideBody.capability.search ?? "", /lbb_embeddings action=list/);
  assert.match(guideBody.capability.search ?? "", /LIMIT 500/);
  assert.match(guideBody.capability.search ?? "", /explain=true/);
  assert.match(guideBody.capability.search_feedback ?? "", /grade 3/);
  assert.match(guideBody.capability.search_feedback ?? "", /grade 1/);
  assert.match(guideBody.capability.search_feedback ?? "", /grade 0/);
  assert.match(
    guideBody.capability.search_feedback ?? "",
    /__lbb_feedback\/main/,
  );
  assert.match(guideBody.how_to, /rate useful\/partial\/bad result sets/);

  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "ontology", graph: "support" },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "ontology_search", query: "person" },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "metadata" },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "entity", entity_type: "Person", name: "Ada" },
  });
  assert.match(calls[1].input, /\/v1\/ontology\?/);
  assert.match(calls[1].input, /graph=support/);
  assert.match(calls[2].input, /\/v1\/ontology\/search\?/);
  assert.match(calls[3].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[4].input, /\/v1\/graph\/entity\?/);
  assert.match(calls[4].input, /type=Person/);
  assert.match(calls[4].input, /name=Ada/);
  assert.equal(calls.length, 5);

  // The Base-family record-history actions were removed with their routes.
  for (const action of ["state", "history", "why", "transitions"]) {
    const removed = await client.callTool({
      name: "lbb_inspect",
      arguments: { action, entity_type: "Person", name: "Ada" },
    });
    assert.equal(removed.isError, true, `${action} must be rejected`);
  }
  assert.equal(calls.length, 5, "a removed action sends no request");

  // The server reads a record at a commit; a valid-time instant is refused
  // before any request, with the commit pin named.
  const validTime = await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "entity",
      entity_type: "Person",
      name: "Ada",
      as_of: "2026-09-12T00:00:00Z",
    },
  });
  assert.equal(validTime.isError, true);
  assert.match(JSON.stringify(validTime.content), /as_of_commit_seq/);
  assert.equal(calls.length, 5, "a refused as_of sends no request");
  await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "entity",
      entity_type: "Person",
      name: "Ada",
      as_of_commit_seq: 4,
    },
  });
  assert.match(calls[5].input, /as_of_commit_seq=4/);
  assert.doesNotMatch(calls[5].input, /[?&]as_of=/);
  await client.close();
});

test("lbb_query routes structured, SPARQL text, and analysis modes", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata")) {
      return ok({ snapshot: { commit_seq: 7 } });
    }
    if (input.includes("/v1/query/sparql-text")) {
      return ok({
        results: JSON.stringify({
          head: { vars: ["s"] },
          results: { bindings: [] },
        }),
      });
    }
    if (input.includes("/v1/graph/summary")) {
      return ok({
        entity_types: [{ name: "Person", count: 2 }],
        relations: [],
      });
    }
    return ok({ ok: true, groups: [] });
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_query",
    arguments: { mode: "structured", body: { patterns: [] } },
  });
  const sparql = await client.callTool({
    name: "lbb_query",
    arguments: { mode: "sparql", query: "SELECT * WHERE { ?s ?p ?o }" },
  });
  await client.callTool({
    name: "lbb_query",
    arguments: { mode: "analyze", metric: "entity_types" },
  });

  assert.match(calls[0].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[1].input, /\/v1\/query\/sparql\?/);
  assert.equal(JSON.parse(calls[1].init.body ?? "{}").as_of_commit_seq, 7);
  assert.match(calls[2].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[3].input, /\/v1\/query\/sparql-text\?/);
  assert.equal(JSON.parse(calls[3].init.body ?? "{}").as_of_commit_seq, 7);
  assert.deepEqual(
    (payload(sparql).data as { head: { vars: string[] } }).head.vars,
    ["s"],
  );
  assert.match(calls[4].input, /\/v1\/graph\/summary\?/);
  await client.close();
});

test("lbb_query mode=sparql lowercases Little Big Brain IRI local names and reports the rewrite", async () => {
  // Regression for the silent-0 casing trap: <…/r/FOR_CLIENT> is a different,
  // non-existent IRI than the canonical <…/r/for_client>, so an uppercase
  // relation matched nothing while returning no error. The tool normalizes it
  // and surfaces a transparent note.
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 3 } });
    if (input.includes("/v1/query/sparql-text")) {
      return ok({
        results: JSON.stringify({
          head: { vars: ["n"] },
          results: { bindings: [] },
        }),
      });
    }
    return ok({});
  };
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "sparql",
      query:
        "SELECT (COUNT(*) AS ?n) WHERE { ?d <https://littlebigbrain.com/r/FOR_CLIENT> ?c }",
    },
  });
  const sparqlCall = calls.find((call) =>
    call.input.includes("/v1/query/sparql-text"),
  );
  const sentQuery = JSON.parse(sparqlCall?.init.body ?? "{}").query as string;
  assert.ok(
    sentQuery.includes("<https://littlebigbrain.com/r/for_client>"),
    "sends the canonical lowercase IRI",
  );
  assert.ok(
    !sentQuery.includes("FOR_CLIENT"),
    "does not send the uppercase local name",
  );
  const notes = (payload(result) as { notes?: string[] }).notes;
  assert.ok(
    Array.isArray(notes) && notes.length === 1,
    "surfaces exactly one normalization note",
  );
  assert.match(notes[0], /FOR_CLIENT/);
  assert.match(notes[0], /for_client/);
  await client.close();
});

test("lbb_query mode=sparql leaves an already-lowercase query untouched (no note)", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 1 } });
    if (input.includes("/v1/query/sparql-text")) {
      return ok({
        results: JSON.stringify({
          head: { vars: ["c"] },
          results: { bindings: [] },
        }),
      });
    }
    return ok({});
  };
  const client = await connect(fetch);
  const q =
    "SELECT ?c WHERE { ?d <https://littlebigbrain.com/r/for_client> ?c }";
  const result = await client.callTool({
    name: "lbb_query",
    arguments: { mode: "sparql", query: q },
  });
  const sparqlCall = calls.find((call) =>
    call.input.includes("/v1/query/sparql-text"),
  );
  assert.equal(
    JSON.parse(sparqlCall?.init.body ?? "{}").query,
    q,
    "query sent verbatim",
  );
  assert.equal(
    (payload(result) as { notes?: string[] }).notes,
    undefined,
    "no note when nothing was rewritten",
  );
  await client.close();
});

test("lbb_query mode=sparql normalizes class/property IRIs, preserves %-escapes, and ignores foreign IRIs", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 5 } });
    if (input.includes("/v1/query/sparql-text")) {
      return ok({
        results: JSON.stringify({
          head: { vars: ["x"] },
          results: { bindings: [] },
        }),
      });
    }
    return ok({});
  };
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "sparql",
      query:
        "SELECT ?x WHERE { ?x a <https://littlebigbrain.com/class/Deal> ; " +
        "<https://littlebigbrain.com/p/Amount> ?a ; " +
        "<https://littlebigbrain.com/r/HAS%2FCALL> ?c ; " +
        '<http://www.w3.org/2000/01/rdf-schema#label> "Acme" }',
    },
  });
  const sparqlCall = calls.find((call) =>
    call.input.includes("/v1/query/sparql-text"),
  );
  const sent = JSON.parse(sparqlCall?.init.body ?? "{}").query as string;
  assert.ok(
    sent.includes("<https://littlebigbrain.com/class/deal>"),
    "class IRI local name lowercased",
  );
  assert.ok(
    sent.includes("<https://littlebigbrain.com/p/amount>"),
    "property IRI local name lowercased",
  );
  assert.ok(
    sent.includes("<https://littlebigbrain.com/r/has%2Fcall>"),
    "letters lowercased while the uppercase %2F escape is preserved byte-for-byte",
  );
  assert.ok(
    sent.includes("<http://www.w3.org/2000/01/rdf-schema#label>"),
    "foreign IRIs (rdfs:label) are left untouched",
  );
  const notes = (payload(result) as { notes?: string[] }).notes ?? [];
  assert.equal(notes.length, 3, "one note per distinct rewritten IRI");
  await client.close();
});

test("structured SPARQL accepts commit pins and rejects every valid-time spelling before HTTP", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 9 } });
    return ok({ solutions: [], groups: [] });
  });
  try {
    for (const args of [
      { body: { patterns: [] }, as_of_commit_seq: 0 },
      { body: { patterns: [], as_of_commit_seq: 3 } },
      { body: { patterns: [], as_of_commit_seq: 3 }, as_of_commit_seq: 4 },
      { body: { patterns: [] } },
    ]) {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: { mode: "structured", ...args },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const sent = JSON.parse(calls.at(-1)?.init.body ?? "{}");
      assert.equal(
        sent.as_of_commit_seq,
        args.as_of_commit_seq ?? args.body.as_of_commit_seq ?? 9,
      );
      assert.equal(Object.hasOwn(sent, "as_of_valid_time"), false);
    }
    const acceptedCalls = calls.length;
    for (const args of [
      { as_of: "2026-09-12T00:00:00Z", body: { patterns: [] } },
      { body: { patterns: [], as_of: "2026-09-12T00:00:00Z" } },
      { body: { patterns: [], as_of_valid_time: "2026-09-12T00:00:00Z" } },
      { body: { patterns: [], as_of_valid_time: null } },
      {
        cursor: Buffer.from(
          JSON.stringify({
            v: 1,
            mode: "structured",
            detail: "compact",
            row_limit: 20,
            offset: 20,
            body: { patterns: [] },
            as_of_commit_seq: 3,
            as_of: "2026-09-12T00:00:00Z",
          }),
        ).toString("base64url"),
      },
    ]) {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: { mode: "structured", ...args },
      });
      assert.equal(result.isError, true);
      assert.match(
        (result.content as { text: string }[])[0].text,
        /valid-time.*not supported.*as_of_commit_seq/,
      );
    }
    assert.equal(calls.length, acceptedCalls);
  } finally {
    await client.close();
  }
});

test("structured SPARQL cursor pages retain their commit and refuse a changed pin", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 7 } });
    const body = JSON.parse(init?.body ?? "{}");
    return ok({
      solutions: [{}],
      row_page: {
        returned: 1,
        total: 3,
        limit: 1,
        offset: body.offset,
        has_more: true,
        next_offset: body.offset + 1,
      },
    });
  });
  try {
    const first = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "structured",
          body: { patterns: [], as_of_commit_seq: 3 },
          as_of_commit_seq: 7,
          row_limit: 1,
        },
      }),
    );
    assert.equal(typeof first.next?.cursor, "string");
    const second = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "structured", cursor: first.next?.cursor },
    });
    assert.notEqual(second.isError, true);
    assert.equal(
      calls.filter((call) => call.input.includes("/v1/graph/metadata")).length,
      0,
    );
    const sent = JSON.parse(calls.at(-1)?.init.body ?? "{}");
    assert.equal(sent.as_of_commit_seq, 7);
    assert.equal(sent.offset, 1);
    assert.equal(Object.hasOwn(sent, "as_of_valid_time"), false);
    const conflict = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "structured",
        cursor: first.next?.cursor,
        as_of_commit_seq: 8,
      },
    });
    assert.equal(conflict.isError, true);
    assert.equal(calls.length, 2);
    assert.match(
      (conflict.content as { text: string }[])[0].text,
      /cursor as_of_commit_seq/,
    );
  } finally {
    await client.close();
  }
});

test("lbb_query forwards typed-attribute group_keys/date_bucket/filter/aggregate bodies untouched", async () => {
  // "Commits per area per month in one query" is a supported server-side shape;
  // the MCP must pass the property/date_bucket group keys, the property filter,
  // and the property-operand aggregate straight through to the server without
  // dropping or rewriting them (only injecting limit/offset/pins).
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 21 } });
    return ok({
      vars: ["m", "area", "n"],
      solutions: [],
      groups: [
        {
          keys: {},
          value_keys: { m: { str: "2026-06" }, area: { str: "docs" } },
          aggregates: { n: { i64: 42 } },
        },
      ],
      row_page: {
        returned: 1,
        total: 1,
        offset: 0,
        limit: 100,
        has_more: false,
      },
    });
  };
  const client = await connect(fetch);
  const body = {
    patterns: [
      {
        subject: { var: "c" },
        predicate: "COMMITTED_TO",
        object: { var: "repo" },
      },
    ],
    group_keys: [
      {
        date_bucket: {
          var: "c",
          field: "committed_at",
          granularity: "month",
          as: "m",
        },
      },
      { property: { var: "c", field: "area", as: "area" } },
    ],
    filters: [
      {
        compare: {
          op: "ne",
          left: { property: { var: "c", field: "area" } },
          right: { value: { str: "" } },
        },
      },
    ],
    aggregates: [{ func: "count", as: "n" }],
    order_by: [{ var: "m" }],
  };
  await client.callTool({
    name: "lbb_query",
    arguments: { mode: "structured", detail: "standard", body },
  });
  const sent = JSON.parse(calls[1].init.body ?? "{}");
  // The group keys / filter / aggregate survive verbatim; MCP only adds paging + pins.
  assert.deepEqual(sent.group_keys, body.group_keys);
  assert.deepEqual(sent.filters, body.filters);
  assert.deepEqual(sent.aggregates, body.aggregates);
  assert.equal(sent.limit, 100);
  assert.equal(sent.offset, 0);
  assert.equal(sent.as_of_commit_seq, 21);
  await client.close();
});

test("lbb_query full SPARQL returns a full row page without generic truncation", async () => {
  const rows = Array.from({ length: 611 }, (_, index) => ({
    s: { type: "literal", value: `r${index}` },
  }));
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata")) {
      return ok({ snapshot: { commit_seq: 611 } });
    }
    return ok({
      results: JSON.stringify({
        head: { vars: ["s"] },
        results: { bindings: rows },
      }),
      row_page: {
        returned: 611,
        total: 611,
        offset: 0,
        limit: 1000,
        has_more: false,
      },
    });
  };
  const client = await connect(fetch);

  const result = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "sparql",
      detail: "full",
      query: "SELECT ?s WHERE { ?s ?p ?o }",
    },
  });

  assert.match(calls[0].input, /\/v1\/graph\/metadata\?/);
  const body = JSON.parse(calls[1].init.body ?? "{}");
  assert.equal(body.limit, 1000);
  assert.equal(body.offset, 0);
  assert.equal(body.as_of_commit_seq, 611);
  const page = payload(result);
  assert.equal(
    (page.data as { results: { bindings: unknown[] } }).results.bindings.length,
    611,
  );
  assert.equal(page.row_page?.returned, 611);
  assert.equal(page.row_page?.total, 611);
  assert.equal(page.truncated, undefined);
  assert.equal(page.next, undefined);
  await client.close();
});

test("lbb_query SPARQL row cursors continue at the next offset", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata")) {
      return ok({ snapshot: { commit_seq: 42 } });
    }
    const body = JSON.parse(init?.body ?? "{}");
    const offset = body.offset ?? 0;
    return ok({
      results: JSON.stringify({
        head: { vars: ["s"] },
        results: {
          bindings: Array.from({ length: 100 }, (_, index) => ({
            s: { type: "literal", value: `row-${offset + index}` },
          })),
        },
      }),
      row_page: {
        returned: 100,
        total: 611,
        offset,
        limit: 100,
        has_more: true,
        next_offset: offset + 100,
      },
    });
  };
  const client = await connect(fetch);

  const first = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "sparql",
        detail: "standard",
        row_limit: 100,
        query: "SELECT ?s WHERE { ?s ?p ?o }",
      },
    }),
  );
  assert.match(first.summary, /returned 100 of 611 rows/);
  assert.equal(first.truncated, true);
  assert.equal(first.next?.mode, "sparql");
  assert.equal(first.next?.row_limit, 100);
  assert.equal(typeof first.next?.cursor, "string");
  assert.match(calls[0].input, /\/v1\/graph\/metadata\?/);
  assert.equal(JSON.parse(calls[1].init.body ?? "{}").as_of_commit_seq, 42);

  const second = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: { mode: "sparql", cursor: first.next?.cursor },
    }),
  );
  assert.equal(
    calls.filter((call) => call.input.includes("/v1/graph/metadata")).length,
    1,
  );
  assert.equal(JSON.parse(calls[2].init.body ?? "{}").offset, 100);
  assert.equal(JSON.parse(calls[2].init.body ?? "{}").as_of_commit_seq, 42);
  for (const call of calls.filter((call) =>
    call.input.includes("/v1/query/sparql-text"),
  )) {
    assert.equal(
      Object.hasOwn(JSON.parse(call.init.body ?? "{}"), "as_of_valid_time"),
      false,
    );
  }
  const savedCursor = JSON.parse(
    Buffer.from(first.next?.cursor as string, "base64url").toString("utf8"),
  );
  assert.equal(Object.hasOwn(savedCursor, "as_of"), false);
  assert.equal(second.row_page?.offset, 100);
  assert.match(
    (second.data as { results: { bindings: { s: { value: string } }[] } })
      .results.bindings[0].s.value,
    /row-100/,
  );
  const conflict = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "sparql",
      cursor: first.next?.cursor,
      query: "SELECT ?x WHERE { ?x ?p ?o }",
    },
  });
  assert.equal(conflict.isError, true);
  assert.match(
    (conflict.content as { type: string; text: string }[])[0].text,
    /cursor query/,
  );
  await client.close();
});

test("lbb_query keeps many grouped rows instead of hard-capping to 3", async () => {
  // 1000 grouped rows: too large to serialize whole, but the adaptive hard cap
  // must keep far more than the old fixed 3 and name the workaround.
  const groups = Array.from({ length: 1000 }, (_, index) => ({
    keys: {},
    value_keys: { area: { str: `area-with-a-reasonably-long-label-${index}` } },
    aggregates: { n: { i64: 1000 - index } },
  }));
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 5 } });
    return ok({
      vars: ["area", "n"],
      solutions: [],
      groups,
      row_page: {
        returned: 1000,
        total: 1000,
        offset: 0,
        limit: 5000,
        has_more: false,
      },
    });
  };
  const client = await connect(fetch);
  const result = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "structured",
        detail: "full",
        body: {
          group_keys: [{ property: { var: "c", field: "area", as: "area" } }],
          aggregates: [{ func: "count", as: "n" }],
        },
      },
    }),
  );
  const data = result.data as { groups?: unknown[] };
  const shownGroups = data.groups?.length ?? 0;
  assert.ok(
    shownGroups > 3,
    `expected the adaptive cap to keep more than 3 groups, got ${shownGroups}`,
  );
  assert.equal(result.truncated, true);
  assert.match(result.summary, /HAVING|cursor|row_limit/);
  // The server returned the complete set (returned == total, has_more false) but
  // it was too big to display whole. The envelope must say so honestly rather
  // than reading as "all 1000 delivered": rows_shown reflects the capped display
  // and is strictly fewer than the server returned.
  assert.equal(result.rows_shown, shownGroups);
  assert.ok(
    result.rows_shown! < 1000,
    "rows_shown must reflect the capped display, not the server total",
  );
  assert.match(result.summary, /byte-bounded page/);
  assert.equal(result.row_page?.returned, shownGroups);
  // A complete-but-too-big page must hand back a working cursor to page the full
  // set at a smaller row_limit — never advise "page with the cursor" with none.
  assert.equal(result.next?.mode, "structured");
  assert.equal(typeof result.next?.cursor, "string");
  assert.equal(
    JSON.parse(
      Buffer.from(result.next?.cursor as string, "base64url").toString(),
    ).offset,
    shownGroups,
  );
  await client.close();
});

test("lbb_query does not warn about hard-capping when the whole result fits", async () => {
  // 120 compact grouped rows serialize well under the MCP output budget, so the
  // envelope must return them all with no hard-cap warning and no rows_shown —
  // the false-positive the feedback flagged was firing on large-but-fitting sets.
  const groups = Array.from({ length: 120 }, (_, index) => ({
    keys: {},
    value_keys: { area: { str: `a${index}` } },
    aggregates: { n: { i64: index } },
  }));
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 7 } });
    return ok({
      vars: ["area", "n"],
      solutions: [],
      groups,
      row_page: {
        returned: 120,
        total: 120,
        offset: 0,
        limit: 5000,
        has_more: false,
      },
    });
  };
  const client = await connect(fetch);
  const result = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "structured",
        detail: "full",
        body: {
          group_keys: [{ property: { var: "c", field: "area", as: "area" } }],
          aggregates: [{ func: "count", as: "n" }],
        },
      },
    }),
  );
  const data = result.data as { groups?: unknown[] };
  assert.equal(data.groups?.length, 120);
  assert.equal(result.truncated, undefined);
  assert.equal(result.rows_shown, undefined);
  assert.doesNotMatch(
    result.summary,
    /hard-capped|showed \d+ of|output budget/,
  );
  assert.match(result.summary, /returned 120 rows/);
  assert.equal(result.next, undefined);
  await client.close();
});

test("lbb_query hard-cap on a partial server page points at the paging cursor", async () => {
  // Server itself withheld rows (returned < total, has_more true) AND the page is
  // too big to display whole: the remedy is the existing paging cursor, and the
  // summary must not claim completeness.
  const bindings = Array.from({ length: 300 }, (_, index) => ({
    s: {
      type: "literal",
      value:
        `subject-with-a-long-enough-value-to-blow-the-budget-${index}`.repeat(
          3,
        ),
    },
    p: {
      type: "literal",
      value:
        `predicate-with-a-long-enough-value-to-blow-the-budget-${index}`.repeat(
          3,
        ),
    },
  }));
  const fetch: FetchLike = async (input, init) => {
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 3 } });
    const offset = JSON.parse(init?.body ?? "{}").offset ?? 0;
    return ok({
      results: JSON.stringify({
        head: { vars: ["s", "p"] },
        results: { bindings },
      }),
      row_page: {
        returned: 300,
        total: 4000,
        offset,
        limit: 300,
        has_more: true,
        next_offset: offset + 300,
      },
    });
  };
  const client = await connect(fetch);
  const result = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "sparql",
        detail: "full",
        row_limit: 300,
        query: "SELECT ?s ?p WHERE { ?s ?p ?o }",
      },
    }),
  );
  assert.equal(result.truncated, true);
  assert.match(result.summary, /returned \d+ of 4000 rows/);
  assert.equal(
    JSON.parse(
      Buffer.from(result.next?.cursor as string, "base64url").toString(),
    ).offset,
    result.row_page?.returned,
  );
  assert.match(result.summary, /continue with the cursor/);
  assert.equal(result.next?.mode, "sparql");
  assert.equal(typeof result.next?.cursor, "string");
  await client.close();
});

test("lbb_query equality-HAVING with row_limit:1 reads the match count off row_page.total", async () => {
  // Documented cheap-count pattern: an equality `having` + row_limit:1 returns
  // the number of matching groups in row_page.total without materializing them.
  // The MCP must forward limit:1 and surface row_page.total unmangled.
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 11 } });
    return ok({
      vars: ["c", "n"],
      solutions: [],
      groups: [
        { keys: { c: { entity: "ent_0" } }, aggregates: { n: { i64: 4 } } },
      ],
      row_page: {
        returned: 1,
        total: 137,
        offset: 0,
        limit: 1,
        has_more: true,
        next_offset: 1,
      },
    });
  };
  const client = await connect(fetch);
  const result = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "structured",
        detail: "standard",
        row_limit: 1,
        body: {
          patterns: [],
          group_by: ["c"],
          aggregates: [{ func: "count", as: "n" }],
          having: [{ left: { var: "n" }, op: "eq", right: { i64: 4 } }],
        },
      },
    }),
  );
  assert.equal(JSON.parse(calls[1].init.body ?? "{}").limit, 1);
  assert.equal(result.row_page?.total, 137);
  assert.match(result.summary, /returned 1 of 137 rows/);
  await client.close();
});

test("lbb_query rejects a combinators body now that the analytics route is gone", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 1 } });
    return ok({});
  };
  const client = await connect(fetch);
  const result = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "structured",
      body: {
        patterns: [],
        combinators: [{ optional: [] }],
      },
    },
  });
  assert.equal(result.isError, true);
  assert.match(
    (result.content as { type: string; text: string }[])[0].text,
    /`combinators`.*no longer accepted.*mode=sparql/s,
  );
  assert.equal(
    calls.some((call) => call.input.includes("/v1/query/")),
    false,
    "a rejected combinators body never reaches a query route",
  );
  await client.close();
});

test("lbb_query structured elevates server-side truncation flags", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata")) {
      return ok({ snapshot: { commit_seq: 9 } });
    }
    return ok({
      solutions: [{ bindings: {} }, { bindings: {} }],
      row_page: {
        returned: 2,
        total: 2,
        offset: 0,
        limit: 100,
        has_more: false,
      },
      truncated: true,
    });
  };
  const client = await connect(fetch);

  const page = payload(
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "structured",
        detail: "standard",
        body: { patterns: [] },
      },
    }),
  );

  assert.equal(JSON.parse(calls[1].init.body ?? "{}").as_of_commit_seq, 9);
  assert.match(page.summary, /returned 2 rows/);
  assert.match(page.summary, /server-truncated: solution cap/);
  assert.equal(page.truncated, true);
  await client.close();
});

test("lbb_query rejects retired query modes", async () => {
  const client = await connect(async () => ok());

  const result = await client.callTool({
    name: "lbb_query",
    arguments: { mode: "shacl", body: { mode: "validate" } },
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.content as { type: string; text: string }[])[0].text,
    /mode|discriminator/i,
  );
  await client.close();
});

test("byte-bounded query pages preserve every long Unicode value at nonzero offsets", async () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({
    value: { type: "literal", value: `${i}:` + "🧠漢字".repeat(600) },
  }));
  const client = await connect(async (input, init) => {
    if (input.includes("metadata")) return ok({ snapshot: { commit_seq: 82 } });
    const body = JSON.parse(init?.body ?? "{}");
    assert.equal(body.as_of_commit_seq, 82);
    const bindings = rows.slice(body.offset, body.offset + body.limit);
    return ok({
      results: JSON.stringify({
        head: { vars: ["value"] },
        results: { bindings },
      }),
      row_page: {
        returned: bindings.length,
        total: rows.length,
        offset: body.offset,
        limit: body.limit,
        has_more: body.offset + bindings.length < rows.length,
        next_offset: body.offset + bindings.length,
      },
    });
  });
  try {
    let args: Record<string, unknown> = {
      mode: "sparql",
      query: "SELECT ?value WHERE {?s ?p ?value}",
      detail: "full",
      row_limit: 20,
    };
    const seen: unknown[] = [];
    for (let page = 0; page < 20; page++) {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: args,
      });
      assert.notEqual(result.isError, true);
      assert.ok(
        Buffer.byteLength((result.content as { text: string }[])[0].text) <=
          80000,
      );
      const body = payload(result);
      const bindings = (body.data as { results: { bindings: unknown[] } })
        .results.bindings;
      assert.equal(body.row_page?.offset, seen.length);
      assert.equal(body.row_page?.returned, bindings.length);
      seen.push(...bindings);
      if (!body.next) break;
      args = body.next;
    }
    assert.deepEqual(seen, rows);
  } finally {
    await client.close();
  }
});

test("search tools route to the embeddings and search API", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ embeddings: [], hits: [] });
  });
  const last = () => {
    const call = calls.at(-1);
    return {
      method: call?.init.method ?? "GET",
      url: call?.input ?? "",
      body: JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>,
    };
  };
  const service = "https://x.test/class/service";
  try {
    // Read only: list, get, preview.
    await client.callTool({
      name: "lbb_embeddings",
      arguments: { action: "list" },
    });
    assert.match(last().url, /\/v1\/embeddings\?/);
    await client.callTool({
      name: "lbb_embeddings",
      arguments: { action: "get", name: "service" },
    });
    assert.match(last().url, /name=service/);
    const noName = await client.callTool({
      name: "lbb_embeddings",
      arguments: { action: "get" },
    });
    assert.equal(noName.isError, true);
    await client.callTool({
      name: "lbb_embeddings",
      arguments: {
        action: "preview",
        class: service,
        from: ["label"],
        sample: 2,
      },
    });
    assert.equal(last().method, "POST");
    assert.match(last().url, /\/v1\/embeddings\/preview/);
    assert.deepEqual(last().body.from, ["label"]);
    assert.equal(last().body.sample, 2);

    // Manage: declare, refresh, and the graph's model.
    await client.callTool({
      name: "lbb_embeddings_manage",
      arguments: {
        action: "declare",
        class: service,
        from: ["label", "calls/label"],
        title: "display_name",
      },
    });
    assert.equal(last().method, "PUT");
    assert.equal(last().body.class, service);
    assert.equal(last().body.title, "display_name");
    await client.callTool({
      name: "lbb_embeddings_manage",
      arguments: { action: "refresh", name: "service" },
    });
    assert.match(last().url, /\/v1\/embeddings\/refresh\?.*name=service/);
    const noRefreshName = await client.callTool({
      name: "lbb_embeddings_manage",
      arguments: { action: "refresh" },
    });
    assert.equal(noRefreshName.isError, true);
    await client.callTool({
      name: "lbb_embeddings_manage",
      arguments: {
        action: "model",
        model: "openai/text-embedding-3-large",
        dim: 3072,
      },
    });
    assert.equal(last().method, "PUT");
    assert.match(last().url, /\/v1\/embeddings\/model/);
    assert.deepEqual(last().body, {
      model: "openai/text-embedding-3-large",
      dim: 3072,
    });
    const noModel = await client.callTool({
      name: "lbb_embeddings_manage",
      arguments: { action: "model" },
    });
    assert.equal(noModel.isError, true);

    // Delete asks for the name twice.
    const before = calls.length;
    const mismatch = await client.callTool({
      name: "lbb_embeddings_delete",
      arguments: { name: "service", confirm: "other" },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(calls.length, before, "no request without the confirmation");
    await client.callTool({
      name: "lbb_embeddings_delete",
      arguments: { name: "service", confirm: "service" },
    });
    assert.equal(last().method, "DELETE");
    assert.match(last().url, /confirm=service/);

    // Search with one filter list and a plan.
    await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "search",
        text: "fraud checks",
        filter: [
          { class: service },
          { via: "calls", to: "payment-service", direction: "out" },
        ],
        explain: true,
      },
    });
    assert.match(last().url, /\/v1\/search/);
    assert.deepEqual(last().body.filter, [
      { class: service },
      { via: "calls", to: "payment-service", direction: "out" },
    ]);
    assert.equal(last().body.explain, true);
    assert.equal("rerank" in last().body, false, "no rerank unless asked");

    // A search that asks for the rerank sends it.
    await client.callTool({
      name: "lbb_query",
      arguments: { mode: "search", text: "fraud checks", rerank: true },
    });
    assert.equal(last().body.rerank, true);
  } finally {
    await client.close();
  }
});

test("fit source tools route to the fit-sources API", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ fit_sources: [] });
  });
  const last = () => {
    const call = calls.at(-1);
    return {
      method: call?.init.method ?? "GET",
      url: call?.input ?? "",
      body: JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>,
    };
  };
  const interview = "https://example.org/class/interview";
  try {
    // Read only: list, get, preview (no model call).
    await client.callTool({
      name: "lbb_fit_sources",
      arguments: { action: "list" },
    });
    assert.match(last().url, /\/v1\/ontology\/fit-sources\?/);
    await client.callTool({
      name: "lbb_fit_sources",
      arguments: { action: "get", name: "interview" },
    });
    assert.match(last().url, /name=interview/);
    await client.callTool({
      name: "lbb_fit_sources",
      arguments: { action: "preview", class: interview, from: ["transcript"] },
    });
    assert.equal(last().method, "POST");
    assert.match(last().url, /\/v1\/ontology\/fit-sources\/preview/);
    assert.deepEqual(last().body, { class: interview, from: ["transcript"] });

    // Manage: a dry run, a declaration and a refresh.
    await client.callTool({
      name: "lbb_fit_sources_manage",
      arguments: { action: "dry_run", class: interview, context: "interviews" },
    });
    assert.deepEqual(last().body, {
      class: interview,
      context: "interviews",
      propose: true,
    });
    await client.callTool({
      name: "lbb_fit_sources_manage",
      arguments: { action: "declare", class: interview, from: ["transcript"] },
    });
    assert.equal(last().method, "PUT");
    assert.deepEqual(last().body, { class: interview, from: ["transcript"] });
    await client.callTool({
      name: "lbb_fit_sources_manage",
      arguments: { action: "refresh", name: "interview" },
    });
    assert.match(
      last().url,
      /\/v1\/ontology\/fit-sources\/refresh\?.*name=interview/,
    );
    const noClass = await client.callTool({
      name: "lbb_fit_sources_manage",
      arguments: { action: "declare" },
    });
    assert.equal(noClass.isError, true);

    // Delete asks for the name twice.
    const before = calls.length;
    const mismatch = await client.callTool({
      name: "lbb_fit_sources_delete",
      arguments: { name: "interview", confirm: "other" },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(calls.length, before, "no request without the confirmation");
    await client.callTool({
      name: "lbb_fit_sources_delete",
      arguments: { name: "interview", confirm: "interview" },
    });
    assert.equal(last().method, "DELETE");
    assert.match(last().url, /confirm=interview/);
  } finally {
    await client.close();
  }
});

test("workflow tools route to the starter and triggered workflow API", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ starters: [] });
  });
  const last = () => {
    const call = calls.at(-1);
    return {
      method: call?.init.method ?? "GET",
      url: call?.input ?? "",
      body: JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>,
    };
  };
  try {
    // Read only: starters, list, get, preview (no model call).
    await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "starters" },
    });
    assert.equal(last().method, "GET");
    assert.match(last().url, /\/v1\/workflows\/starters\?/);
    await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "list", graph: "crm" },
    });
    assert.match(last().url, /\/v1\/workflows\/triggered\?graph=crm$/);
    await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "get", starter: "ontology.fit", name: "interview" },
    });
    assert.match(
      last().url,
      /\/v1\/workflows\/triggered\?.*starter=ontology\.fit&name=interview/,
    );
    const noName = await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "get", starter: "ontology.fit" },
    });
    assert.equal(noName.isError, true);
    await client.callTool({
      name: "lbb_workflows",
      arguments: {
        action: "preview",
        starter: "search.embed",
        class: "Ticket",
        fields: ["title", "body"],
        sample: 2,
      },
    });
    assert.equal(last().method, "POST");
    assert.match(last().url, /\/v1\/workflows\/triggered\/preview/);
    assert.deepEqual(last().body, {
      starter: "search.embed",
      watch: { class: "Ticket", fields: ["title", "body"] },
      sample: 2,
    });
    assert.equal("propose" in last().body, false, "a read never runs models");

    // Manage: use and refresh.
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "use",
        starter: "ontology.fit",
        class: "Interview",
        fields: ["transcript"],
        params: { context: "interviews with employees" },
        budget_usd_per_month: 5,
      },
    });
    assert.equal(last().method, "PUT");
    assert.match(last().url, /\/v1\/workflows\/triggered\?/);
    assert.deepEqual(last().body, {
      starter: "ontology.fit",
      watch: { class: "Interview", fields: ["transcript"] },
      params: { context: "interviews with employees" },
      budget_usd_per_month: 5,
    });
    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "refresh",
        starter: "ontology.fit",
        name: "interview",
      },
    });
    assert.equal(last().method, "POST");
    assert.match(
      last().url,
      /\/v1\/workflows\/triggered\/refresh\?.*starter=ontology\.fit&name=interview/,
    );
    const before = calls.length;
    const noStarter = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "use", class: "Interview" },
    });
    assert.equal(noStarter.isError, true);
    const fieldsWithoutClass = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "use",
        starter: "search.embed",
        fields: ["label"],
      },
    });
    assert.equal(fieldsWithoutClass.isError, true);
    const noRefreshName = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "refresh", starter: "ontology.fit" },
    });
    assert.equal(noRefreshName.isError, true);
    assert.equal(calls.length, before, "no request for an incomplete call");

    // Delete asks for the name twice.
    const mismatch = await client.callTool({
      name: "lbb_workflows_delete",
      arguments: {
        starter: "ontology.fit",
        name: "interview",
        confirm: "other",
      },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(calls.length, before, "no request without the confirmation");
    await client.callTool({
      name: "lbb_workflows_delete",
      arguments: {
        starter: "ontology.fit",
        name: "interview",
        confirm: "interview",
      },
    });
    assert.equal(last().method, "DELETE");
    assert.match(last().url, /\/v1\/workflows\/triggered\?/);
    assert.match(
      last().url,
      /starter=ontology\.fit&name=interview&confirm=interview/,
    );
  } finally {
    await client.close();
  }
});

test("a developer workflow is created with its workflow, owned outputs and batch, and pauses and resumes", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ starter: "workflow", name: "notes" });
  });
  const last = () => {
    const call = calls.at(-1);
    return {
      method: call?.init.method ?? "GET",
      url: call?.input ?? "",
      body: JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>,
    };
  };
  const developer = {
    starter: "workflow",
    name: "notes",
    class: "Note",
    fields: ["body"],
    workflow: { workflow_type: "word-count", version: "v1" },
    owns: { properties: ["word_count"] },
    batch: 8,
  };
  const sent = {
    starter: "workflow",
    name: "notes",
    watch: { class: "Note", fields: ["body"] },
    workflow: { workflow_type: "word-count", version: "v1" },
    owns: { properties: ["word_count"] },
    batch: 8,
  };
  try {
    // A preview takes the same settings: it checks the request.
    await client.callTool({
      name: "lbb_workflows",
      arguments: { action: "preview", ...developer },
    });
    assert.equal(last().method, "POST");
    assert.match(last().url, /\/v1\/workflows\/triggered\/preview/);
    assert.deepEqual(last().body, sent);

    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "use", graph: "crm", ...developer },
    });
    assert.equal(last().method, "PUT");
    assert.match(last().url, /\/v1\/workflows\/triggered\?graph=crm$/);
    assert.deepEqual(last().body, sent);

    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "pause", starter: "workflow", name: "notes" },
    });
    assert.equal(last().method, "POST");
    assert.match(
      last().url,
      /\/v1\/workflows\/triggered\/pause\?.*starter=workflow&name=notes$/,
    );
    assert.deepEqual(last().body, { paused: true });

    await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "resume",
        starter: "workflow",
        name: "notes",
        graph: "crm",
      },
    });
    assert.match(
      last().url,
      /\/v1\/workflows\/triggered\/pause\?graph=crm&starter=workflow&name=notes$/,
    );
    assert.deepEqual(last().body, { paused: false });

    const before = calls.length;
    const noName = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "pause", starter: "workflow" },
    });
    assert.equal(noName.isError, true);
    const bigBatch = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "use", ...developer, batch: 65 },
    });
    assert.equal(bigBatch.isError, true);
    const looseWorkflow = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "use",
        ...developer,
        workflow: { workflow_type: "word-count" },
      },
    });
    assert.equal(looseWorkflow.isError, true);
    assert.equal(calls.length, before, "no request for an incomplete call");
  } finally {
    await client.close();
  }
});

test("lbb_query mode=search honours detail: full returns every hit and its whole text", async () => {
  const long = "x".repeat(900);
  const hits = Array.from({ length: 20 }, (_, i) => ({
    id: `h${i}`,
    iri: `https://x.test/e/${i}`,
    label: `hit ${i}`,
    class: "https://x.test/class/job",
    embedding: "job",
    score: 1 - i / 100,
    text: `description: ${long}`,
  }));
  const client = await connect(async (input) =>
    input.includes("/v1/search")
      ? ok({ hits, embeddings: [], served_at_seq: 1 })
      : ok({}),
  );
  try {
    const full = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "search",
        text: "retrieval engineer",
        top_k: 20,
        detail: "full",
        include: ["text"],
      },
    });
    assert.notEqual(full.isError, true, JSON.stringify(full));
    const fullData = payload(full).data as { hits: { text: string }[] };
    assert.equal(fullData.hits.length, 20);
    assert.equal(fullData.hits[0].text, `description: ${long}`);
    assert.notEqual(payload(full).truncated, true);

    // The compact default still trims, and its hint names the next level.
    const compact = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "search", text: "retrieval engineer", top_k: 20 },
    });
    const compactPayload = payload(compact) as {
      data: { hits: unknown[] };
      truncated?: boolean;
      next?: { detail?: string };
    };
    assert.equal(compactPayload.data.hits.length, 5);
    assert.equal(compactPayload.truncated, true);
    assert.equal(compactPayload.next?.detail, "standard");
  } finally {
    await client.close();
  }
});

test("lbb_model_choice reads the options, the trials and the switches", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const path = new URL(input).pathname;
    if (path.endsWith("/options")) {
      return ok({
        jobs: [],
        available: true,
        budget_micro_usd: 3_000_000,
        target_default: 40,
        target_max: 100,
      });
    }
    if (path.endsWith("/switches")) return ok({ switches: [] });
    return ok({ trials: [] });
  };
  const client = await connect(fetch);

  const options = await client.callTool({
    name: "lbb_model_choice",
    arguments: { action: "options", graph: "crm" },
  });
  const trials = await client.callTool({
    name: "lbb_model_choice",
    arguments: { action: "trials", job: "ask", limit: 5 },
  });
  await client.callTool({
    name: "lbb_model_choice",
    arguments: { action: "trial", trial_id: "t1" },
  });
  await client.callTool({
    name: "lbb_model_choice",
    arguments: { action: "trial_call", trial_id: "t1", call_id: "c1" },
  });
  await client.callTool({
    name: "lbb_model_choice",
    arguments: { action: "switches" },
  });
  const missing = await client.callTool({
    name: "lbb_model_choice",
    arguments: { action: "trial_call", trial_id: "t1" },
  });

  assert.notEqual(options.isError, true);
  assert.equal(
    (payload(options).data as Schemas["ModelTrialOptionsResponse"]).available,
    true,
  );
  assert.notEqual(trials.isError, true);
  assert.equal(missing.isError, true);
  assert.deepEqual(
    calls.map((call) => {
      const url = new URL(call.input);
      return `${call.init.method ?? "GET"} ${url.pathname}?${url.searchParams}`;
    }),
    [
      "GET /v1/models/trials/options?graph=crm",
      "GET /v1/models/trials?graph=g&job=ask&limit=5",
      "GET /v1/models/trials/get?graph=g&id=t1",
      "GET /v1/models/trials/call?graph=g&id=t1&call=c1",
      "GET /v1/models/switches?graph=g",
    ],
  );
  await client.close();
});
