import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, payload, type Call } from "./test-support.js";

test("lbb_search routes single, multi, and path-following retrieval modes", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      search_id: "srch_1",
      assertions: Array.from({ length: 8 }, (_, index) => ({
        id: `a${index}`,
        evidence: "x".repeat(350),
      })),
    });
  };
  const client = await connect(fetch);

  const search = await client.callTool({
    name: "lbb_search",
    arguments: { query: "identity", top_k: 3 },
  });
  assert.match(calls[0].input, /\/v1\/graph\/search\?/);
  assert.match(calls[0].input, /graph=g/);
  assert.equal(JSON.parse(calls[0].init.body ?? "{}").top_k, 3);
  const compact = payload(search);
  assert.equal(
    (compact.data as { assertions: unknown[] }).assertions.length,
    5,
  );
  assert.equal(compact.counts?.assertions, 8);
  assert.equal(compact.truncated, true);
  assert.equal(compact.next?.detail, "standard");
  // Point-of-use feedback affordance: a ready-to-run lbb_commit template with
  // the grade legend and the search_id pre-filled from this run.
  const feedback = (
    compact as unknown as {
      feedback?: {
        grades?: Record<string, number>;
        example?: {
          tool?: string;
          args?: {
            mode?: string;
            search_feedback?: { search_id?: string; query?: string };
          };
        };
      };
    }
  ).feedback;
  assert.ok(feedback, "lbb_search result carries a feedback affordance");
  assert.equal(feedback.grades?.ideal_or_good, 3);
  assert.equal(feedback.example?.tool, "lbb_commit");
  assert.equal(feedback.example?.args?.mode, "search_feedback");
  assert.equal(feedback.example?.args?.search_feedback?.search_id, "srch_1");
  assert.equal(feedback.example?.args?.search_feedback?.query, "identity");

  const full = await client.callTool({
    name: "lbb_search",
    arguments: { query: "identity", detail: "full" },
  });
  assert.equal(
    (payload(full).data as { assertions: unknown[] }).assertions.length,
    8,
  );

  await client.callTool({
    name: "lbb_search",
    arguments: { queries: ["identity", "login"], top_k: 4 },
  });
  assert.match(calls[2].input, /\/v1\/search\/multi\?/);
  const multiBody = JSON.parse(calls[2].init.body ?? "{}");
  assert.equal(multiBody.subqueries.length, 2);
  assert.equal(multiBody.explain, false);

  await client.callTool({
    name: "lbb_search",
    arguments: { query: "identity", follow_paths: true, max_hops: 3 },
  });
  assert.match(calls[3].input, /\/v1\/graph\/semantic-traverse\?/);
  assert.equal(JSON.parse(calls[3].init.body ?? "{}").max_hops, 3);

  // The bitemporal cursor rides through as body fields (valid-time arg is
  // spelled `as_of` at the tool surface, `as_of_valid_time` on the wire).
  await client.callTool({
    name: "lbb_search",
    arguments: {
      query: "identity",
      as_of_commit_seq: 7,
      as_of: "2026-01-15T00:00:00Z",
    },
  });
  const pinnedBody = JSON.parse(calls[4].init.body ?? "{}");
  assert.equal(pinnedBody.as_of_commit_seq, 7);
  assert.equal(pinnedBody.as_of_valid_time, "2026-01-15T00:00:00Z");
  await client.close();
});

test("lbb_inspect consolidates guide, ontology, metadata, state, history, why, and traverse", async () => {
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
    capability: { search_feedback?: string };
    how_to: string;
    possibilities: { run: { tool: string } }[];
  };
  assert.ok(guideBody.possibilities.every((p) => p.run.tool === "lbb_query"));
  assert.match(guideBody.capability.search_feedback ?? "", /grade 3/);
  assert.match(guideBody.capability.search_feedback ?? "", /grade 1/);
  assert.match(guideBody.capability.search_feedback ?? "", /grade 0/);
  assert.match(
    guideBody.capability.search_feedback ?? "",
    /__lbb_feedback\/main/,
  );
  assert.match(guideBody.how_to, /rate useful\/partial\/bad retrieval results/);

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
  await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "state",
      entity_type: "Person",
      name: "Ada",
      relation: "KNOWS",
    },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "history", entity_type: "Person", name: "Ada" },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "why",
      source_type: "Person",
      source_name: "Ada",
      relation: "KNOWS",
      target_type: "Person",
      target_name: "Grace",
    },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "traverse",
      entity_type: "Person",
      name: "Ada",
      direction: "out",
    },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "transitions",
      entity_type: "Person",
      name: "Ada",
      relation: "IN_STAGE",
    },
  });

  assert.match(calls[1].input, /\/v1\/ontology\?/);
  assert.match(calls[1].input, /graph=support/);
  assert.match(calls[2].input, /\/v1\/ontology\/search\?/);
  assert.match(calls[3].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[4].input, /\/v1\/graph\/entity\?/);
  assert.match(calls[4].input, /type=Person/);
  assert.match(calls[4].input, /name=Ada/);
  assert.match(calls[5].input, /\/v1\/query\/state\?/);
  assert.match(calls[6].input, /\/v1\/query\/history\?/);
  assert.match(calls[7].input, /\/v1\/query\/why\?/);
  assert.match(calls[8].input, /\/v1\/graph\/traverse\?/);
  assert.match(calls[9].input, /\/v1\/query\/transitions\?/);
  await client.close();
});

test("lbb_inspect entity flags a display-capped edge sample with runnable paged reads", async () => {
  // A high-degree node: the server returns the full arrays, but the display caps
  // them to the detail limit while counts holds the true totals. The response
  // must point at the paged edges/history reads so the workaround is discoverable
  // in-band rather than tribal knowledge.
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graph/entity")) {
      return ok({
        entity: { entity_type: "Component", name: "docs" },
        current_state: [],
        attributes: {},
        metadata: {},
        observations: [],
        outgoing: Array.from({ length: 2 }, (_, i) => ({
          relation: "OWNS",
          target: `t${i}`,
        })),
        incoming: Array.from({ length: 345 }, (_, i) => ({
          relation: "TOUCHES",
          source: `c${i}`,
        })),
        history: Array.from({ length: 40 }, (_, i) => ({
          relation: "TOUCHES",
          commit_seq: i,
        })),
        snapshot: {},
      });
    }
    return ok({});
  };
  const client = await connect(fetch);
  const result = payload(
    await client.callTool({
      name: "lbb_inspect",
      arguments: { action: "entity", entity_type: "Component", name: "docs" },
    }),
  );
  const hint = (
    result as unknown as {
      edge_sample?: {
        capped_totals?: Record<string, number>;
        full_reads?: { tool: string; arguments: Record<string, unknown> }[];
        note?: string;
      };
    }
  ).edge_sample;
  assert.ok(hint, "expected an edge_sample hint on a high-degree node");
  // incoming (345) and history (40) exceed the compact cap of 5; outgoing (2) does not.
  assert.equal(hint!.capped_totals?.incoming, 345);
  assert.equal(hint!.capped_totals?.history, 40);
  assert.equal(hint!.capped_totals?.outgoing, undefined);
  const reads = hint!.full_reads ?? [];
  const incomingRead = reads.find(
    (r) => r.arguments.action === "edges" && r.arguments.direction === "in",
  );
  assert.ok(
    incomingRead,
    "expected a runnable paged edges read for the capped incoming edges",
  );
  assert.equal(incomingRead!.arguments.entity_type, "Component");
  assert.equal(incomingRead!.arguments.name, "docs");
  assert.ok(
    reads.some((r) => r.arguments.action === "history"),
    "expected a paged history read",
  );
  assert.ok(
    !reads.some((r) => r.arguments.direction === "out"),
    "must not advertise a paged read for the uncapped outgoing edges",
  );
  await client.close();
});

test("lbb_inspect entity omits the edge-cap hint when the sample is not capped", async () => {
  const fetch: FetchLike = async (input) => {
    if (input.includes("/v1/graph/entity")) {
      return ok({
        entity: { entity_type: "Component", name: "tiny" },
        current_state: [],
        attributes: {},
        metadata: {},
        observations: [],
        outgoing: [{ relation: "OWNS", target: "t0" }],
        incoming: [{ relation: "TOUCHES", source: "c0" }],
        history: [],
        snapshot: {},
      });
    }
    return ok({});
  };
  const client = await connect(fetch);
  const result = payload(
    await client.callTool({
      name: "lbb_inspect",
      arguments: {
        action: "entity",
        entity_type: "Component",
        name: "tiny",
        detail: "full",
      },
    }),
  );
  assert.equal(
    (result as unknown as { edge_sample?: unknown }).edge_sample,
    undefined,
  );
  await client.close();
});

test("lbb_inspect edges pages one entity's edges with direction and a snapshot pin", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      object: "list",
      data: [],
      has_more: true,
      next_cursor: "300",
      snapshot: {},
      total_count: 782,
    });
  };
  const client = await connect(fetch);

  const result = await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "edges",
      entity_type: "PERSON",
      name: "ada",
      direction: "out",
      row_limit: 150,
      cursor: "150",
      as_of_commit_seq: 42,
    },
  });

  const input = calls[0].input;
  assert.match(input, /\/v1\/graph\/edges\?/);
  assert.match(input, /type=PERSON/);
  assert.match(input, /name=ada/);
  assert.match(input, /direction=out/);
  assert.match(input, /limit=150/);
  assert.match(input, /cursor=150/);
  assert.match(input, /as_of_commit_seq=42/);
  // The unified list envelope surfaces total_count + next_cursor for paging.
  const data = payload(result).data as {
    total_count: number;
    next_cursor: string;
  };
  assert.equal(data.total_count, 782);
  assert.equal(data.next_cursor, "300");
  await client.close();
});

test("lbb_inspect exposes RDF schema preview, audit, and stored rules", async () => {
  const calls: Call[] = [];
  const shapeSource = "@prefix sh: <http://www.w3.org/ns/shacl#> .";
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/schema/preview")) {
      return ok({
        graph: { tenant_id: "acme", graph_id: "support", branch_id: "draft" },
        verdict: "restrictive",
        can_publish: false,
        publish_mode_allowed: ["warn"],
        preview_digest: "sha256:preview",
        desired_mode: "reject",
        proposed_ontology_version: 2,
        proposed_shapes_version: 3,
        diff: [
          {
            kind: "restrictive",
            subject: "shape",
            message: "requires more CALLS",
          },
        ],
        audit: {
          conforms: false,
          result_count: 1,
          results: [
            { focus_node: "alpha", component: "MinCountConstraintComponent" },
          ],
          messages: ["one violation"],
        },
        messages: ["reject is not available until current data conforms"],
      });
    }
    if (input.includes("/v1/schema/audit")) {
      return ok({ conforms: true, result_count: 0, results: [] });
    }
    if (input.includes("/v1/inference/rules")) {
      return ok({
        version: 4,
        rules: [{ name: "transitive_calls", body: [], head: {} }],
      });
    }
    return ok({ enforce_mode: "warn", shape_count: 2 });
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "schema", graph: "support", branch: "draft" },
  });
  const preview = await client.callTool({
    name: "lbb_inspect",
    arguments: {
      action: "schema_preview",
      graph: "support",
      branch: "draft",
      desired_mode: "reject",
      base_shapes_version: 2,
      shapes: { source: shapeSource, format: "turtle" },
    },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "schema_audit", graph: "support", branch: "draft" },
  });
  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "rules", graph: "support", branch: "draft" },
  });

  assert.match(calls[0].input, /\/v1\/schema\?/);
  assert.match(calls[0].input, /graph=support/);
  assert.match(calls[0].input, /branch=draft/);
  assert.match(calls[1].input, /\/v1\/schema\/preview\?/);
  const previewBody = JSON.parse(calls[1].init.body ?? "{}");
  assert.equal(previewBody.desired_mode, "reject");
  assert.equal(previewBody.base_shapes_version, 2);
  assert.deepEqual(previewBody.shapes, {
    source: shapeSource,
    format: "turtle",
  });
  const previewData = payload(preview).data as {
    audit: { result_count: number; sample_results: unknown[] };
    suggested_publish_schema: { tool: string; args: Record<string, unknown> };
  };
  assert.equal(previewData.audit.result_count, 1);
  assert.equal(previewData.audit.sample_results.length, 1);
  assert.equal(previewData.suggested_publish_schema.tool, "lbb_configure");
  assert.equal(
    previewData.suggested_publish_schema.args.action,
    "publish_schema",
  );
  assert.equal(previewData.suggested_publish_schema.args.desired_mode, "warn");
  assert.equal(
    previewData.suggested_publish_schema.args.confirm_restrictive,
    true,
  );
  assert.deepEqual(previewData.suggested_publish_schema.args.shapes, {
    source: shapeSource,
    format: "turtle",
  });
  assert.match(calls[2].input, /\/v1\/schema\/audit\?/);
  assert.match(calls[3].input, /\/v1\/inference\/rules\?/);
  await client.close();
});

test("lbb_query routes structured, SPARQL text, SHACL, inference, retrieval premise, and analysis modes", async () => {
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
  await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "structured",
      body: { patterns: [], combinators: [{ optional: [] }] },
    },
  });
  const sparql = await client.callTool({
    name: "lbb_query",
    arguments: { mode: "sparql", query: "SELECT * WHERE { ?s ?p ?o }" },
  });
  await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "shacl",
      shacl_mode: "validate",
      shapes: [{ targetClass: "Customer" }],
    },
  });
  // A rule that uses an entity-constant term and a not_exists combinator must
  // pass the typed schema and route to the inference run endpoint — the shapes
  // that make universal/constant roll-ups expressible.
  await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "infer",
      rules: [
        {
          name: "phase_complete",
          body: [
            {
              subject: { var: "phase" },
              predicate: "HAS_DELIVERABLE",
              object: { var: "d" },
            },
          ],
          combinators: [
            {
              not_exists: [
                {
                  subject: { var: "phase" },
                  predicate: "HAS_INCOMPLETE_DELIVERABLE",
                  object: { var: "x" },
                },
              ],
            },
          ],
          head: {
            subject: { var: "phase" },
            predicate: "HAS_ROLLUP_STATUS",
            object: {
              entity: { entity_type: "DeliveryStatus", name: "Complete" },
            },
          },
        },
      ],
    },
  });
  await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "retrieval_premises",
      anchor_type: "Topic",
      anchor_name: "Identity",
      relation: "MATCHES",
      query: "identity",
    },
  });
  await client.callTool({
    name: "lbb_query",
    arguments: { mode: "analyze", metric: "entity_types" },
  });

  assert.match(calls[0].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[1].input, /\/v1\/query\/sparql\?/);
  assert.equal(JSON.parse(calls[1].init.body ?? "{}").as_of_commit_seq, 7);
  assert.match(calls[2].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[3].input, /\/v1\/query\/analytics\?/);
  assert.equal(JSON.parse(calls[3].init.body ?? "{}").as_of_commit_seq, 7);
  assert.match(calls[4].input, /\/v1\/graph\/metadata\?/);
  assert.match(calls[5].input, /\/v1\/query\/sparql-text\?/);
  assert.equal(JSON.parse(calls[5].init.body ?? "{}").as_of_commit_seq, 7);
  assert.deepEqual(
    (payload(sparql).data as { head: { vars: string[] } }).head.vars,
    ["s"],
  );
  assert.match(calls[6].input, /\/v1\/query\/shacl\?/);
  assert.equal(JSON.parse(calls[6].init.body ?? "{}").mode, "validate");
  assert.match(calls[7].input, /\/v1\/inference\/run\?/);
  assert.match(calls[8].input, /\/v1\/inference\/retrieval-premises\?/);
  assert.match(calls[9].input, /\/v1\/graph\/summary\?/);
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

test("lbb_query structured accepts top-level as_of / as_of_commit_seq and rejects a bare body as_of", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/graph/metadata"))
      return ok({ snapshot: { commit_seq: 9 } });
    return ok({ ok: true, groups: [] });
  };
  const client = await connect(fetch);

  // Top-level as_of_commit_seq pins without a metadata round-trip and lands in
  // the request body (the advertised top-level param now actually works).
  await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "structured",
      body: { patterns: [] },
      as_of_commit_seq: 3,
    },
  });
  // Top-level as_of (valid-time) is folded into as_of_valid_time — the field the
  // server reads — instead of being silently dropped.
  await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "structured",
      body: { patterns: [] },
      as_of: "2026-03-01T00:00:00Z",
    },
  });
  // A bare `as_of` key inside the body is the silent-no-op trap: turn it into a
  // clear, actionable error rather than charting head-snapshot data.
  const trap = await client.callTool({
    name: "lbb_query",
    arguments: {
      mode: "structured",
      body: { patterns: [], as_of: "2026-03-01T00:00:00Z" },
    },
  });

  // Call 0: explicit commit seq pins directly (no metadata round-trip).
  const first = JSON.parse(calls[0].init.body ?? "{}");
  assert.match(calls[0].input, /\/v1\/query\/sparql\?/);
  assert.equal(first.as_of_commit_seq, 3);
  // Call 1: metadata fetch (no commit seq given), then call 2: the sparql request.
  assert.match(calls[1].input, /\/v1\/graph\/metadata\?/);
  const second = JSON.parse(calls[2].init.body ?? "{}");
  assert.match(calls[2].input, /\/v1\/query\/sparql\?/);
  assert.equal(second.as_of_valid_time, "2026-03-01T00:00:00Z");
  assert.equal(second.as_of_commit_seq, 9); // pinned from head metadata
  assert.equal(trap.isError, true);
  assert.match(
    (trap.structuredContent as { error: { message: string } }).error.message,
    /as_of_valid_time/,
  );
  await client.close();
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
  assert.match(result.summary, /showed \d+ of 1000 rows/);
  // A complete-but-too-big page must hand back a working cursor to page the full
  // set at a smaller row_limit — never advise "page with the cursor" with none.
  assert.equal(result.next?.mode, "structured");
  assert.equal(typeof result.next?.cursor, "string");
  assert.ok((result.next?.row_limit as number) <= shownGroups);
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
      value: `subject-with-a-long-enough-value-to-blow-the-budget-${index}`,
    },
    p: {
      type: "literal",
      value: `predicate-with-a-long-enough-value-to-blow-the-budget-${index}`,
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
  assert.match(result.summary, /returned 300 of 4000 rows/);
  assert.match(result.summary, /page with the cursor/);
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

test("lbb_query rejects HAVING combined with combinators instead of dropping it", async () => {
  const fetch: FetchLike = async (input) => {
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
        having: [{ left: { var: "n" }, op: "gt", right: { i64: 1 } }],
      },
    },
  });
  assert.equal(result.isError, true);
  assert.match(
    (result.content as { type: string; text: string }[])[0].text,
    /HAVING is not evaluated alongside/,
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

test("lbb_query rejects fields outside the selected mode schema", async () => {
  const client = await connect(async () => ok());

  const result = await client.callTool({
    name: "lbb_query",
    arguments: { mode: "shacl", body: { mode: "validate" } },
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.content as { type: string; text: string }[])[0].text,
    /body/,
  );
  await client.close();
});
