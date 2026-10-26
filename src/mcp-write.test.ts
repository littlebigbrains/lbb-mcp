import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, payload, type Call } from "./test-support.js";

test("lbb_configure defines ontologies and atomically publishes schemas", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ ok: true });
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "define_ontology",
      graph: "support",
      entity_types: [{ name: "Customer" }, { name: "Ticket" }],
      relations: [{ name: "OPENED", source: ["Customer"], target: ["Ticket"] }],
    },
  });
  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "publish_schema",
      graph: "support",
      shapes: {
        source: "@prefix sh: <http://www.w3.org/ns/shacl#> .",
        format: "turtle",
      },
      desired_mode: "warn",
    },
  });

  assert.match(calls[0].input, /\/v1\/ontology\/define\?/);
  assert.match(calls[0].input, /graph=support/);
  const ontologyBody = JSON.parse(calls[0].init.body ?? "{}");
  assert.equal(ontologyBody.format, "spec");
  assert.deepEqual(
    JSON.parse(ontologyBody.source).entity_types.map(
      (e: { name: string }) => e.name,
    ),
    ["Customer", "Ticket"],
  );
  assert.match(calls[1].input, /\/v1\/schema\/publish\?/);
  assert.match(calls[1].input, /graph=support/);
  const schemaBody = JSON.parse(calls[1].init.body ?? "{}");
  assert.equal(schemaBody.desired_mode, "warn");
  assert.match(schemaBody.shapes.source, /shacl/);
  await client.close();
});

test("lbb_configure evolve_ontology applies ordered additive ops", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      base_ontology_version: 1,
      ontology_version: 2,
      applied: [],
      messages: [],
    });
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "evolve_ontology",
      graph: "support",
      ops: [
        { op: "add_entity_type", name: "Phase" },
        {
          op: "widen_relation",
          relation: "EMPLOYS",
          add_domain: ["Phase"],
          add_range: ["Org"],
        },
        {
          op: "add_relation",
          name: "HAS_PHASE",
          domain: ["Org"],
          range: ["Phase"],
          cardinality: "one_to_many",
          inverse_name: "PHASE_OF",
        },
      ],
    },
  });

  assert.match(calls[0].input, /\/v1\/ontology\/evolve\?/);
  assert.match(calls[0].input, /graph=support/);
  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.equal(body.ops.length, 3);
  assert.equal(body.ops[0].op, "add_entity_type");
  assert.equal(body.ops[1].op, "widen_relation");
  assert.equal(body.ops[1].relation, "EMPLOYS");
  assert.deepEqual(body.ops[1].add_domain, ["Phase"]);
  assert.deepEqual(body.ops[1].add_range, ["Org"]);
  assert.equal(body.ops[2].op, "add_relation");
  assert.equal(body.ops[2].name, "HAS_PHASE");
  assert.deepEqual(body.ops[2].domain, ["Org"]);
  assert.deepEqual(body.ops[2].range, ["Phase"]);
  assert.equal(body.ops[2].cardinality, "one_to_many");
  assert.equal(body.ops[2].inverse_name, "PHASE_OF");
  await client.close();
});

test("lbb_configure evolve_ontology carries rename and set-metadata ops", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ ontology_version: 2, applied: [], messages: [] });
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "evolve_ontology",
      graph: "crm",
      ops: [
        { op: "rename_entity_type", from: "Org", to: "Organization" },
        { op: "rename_relation", from: "INVOLVES", to: "HAS_PHASE" },
        {
          op: "set_relation_inverse",
          relation: "HAS_PHASE",
          inverse_name: "PHASE_OF",
        },
        {
          op: "set_relation_cardinality",
          relation: "HAS_PHASE",
          cardinality: "one_to_many",
        },
      ],
    },
  });

  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.equal(body.ops.length, 4);
  assert.equal(body.ops[0].op, "rename_entity_type");
  assert.equal(body.ops[0].from, "Org");
  assert.equal(body.ops[0].to, "Organization");
  assert.equal(body.ops[1].op, "rename_relation");
  assert.equal(body.ops[1].to, "HAS_PHASE");
  assert.equal(body.ops[2].op, "set_relation_inverse");
  assert.equal(body.ops[2].inverse_name, "PHASE_OF");
  assert.equal(body.ops[3].op, "set_relation_cardinality");
  assert.equal(body.ops[3].cardinality, "one_to_many");
  await client.close();
});

test("lbb_configure evolve_ontology carries the property unit and constraint ops", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ ontology_version: 2, applied: [], messages: [] });
  });
  try {
    const ops = [
      {
        op: "add_property",
        name: "status",
        value_type: "keyword",
        allowed_values: ["open", "done"],
      },
      { op: "add_property", name: "width", value_type: "f64", unit: "cm" },
      { op: "set_property_unit", property: "width", unit: "mm" },
      { op: "set_property_unit", property: "depth" },
      {
        op: "set_property_constraint",
        property: "stage",
        allowed_values: ["lead", "won"],
      },
      { op: "set_property_constraint", property: "kind", allowed_values: [] },
    ];
    const result = await client.callTool({
      name: "lbb_configure",
      arguments: { action: "evolve_ontology", graph: "crm", ops },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(calls[0].input, /\/v1\/ontology\/evolve\?/);
    assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}").ops, ops);

    const unknownField = await client.callTool({
      name: "lbb_configure",
      arguments: {
        action: "evolve_ontology",
        ops: [{ op: "set_property_unit", name: "width", unit: "mm" }],
      },
    });
    assert.equal(unknownField.isError, true);
    assert.equal(calls.length, 1, "a malformed op sends nothing");
  } finally {
    await client.close();
  }
});

test("lbb_configure evolve_ontology carries subtractive ops and the conflict override", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      ontology_version: 2,
      applied: [],
      conflicts: [],
      messages: [],
    });
  };
  // LBB_MCP_DESTRUCTIVE=allow: the removals go through without a question.
  const client = await connect(fetch, { destructiveWithoutApproval: "allow" });

  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "evolve_ontology",
      graph: "crm",
      allow_data_conflicts: true,
      ops: [
        {
          op: "narrow_relation",
          relation: "INVOLVES",
          remove_domain: ["Person"],
        },
        { op: "remove_entity_type", name: "LegacyType" },
        { op: "remove_relation", name: "OLD_REL" },
      ],
    },
  });

  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.equal(body.allow_data_conflicts, true);
  assert.equal(body.ops.length, 3);
  assert.equal(body.ops[0].op, "narrow_relation");
  assert.deepEqual(body.ops[0].remove_domain, ["Person"]);
  assert.equal(body.ops[1].op, "remove_entity_type");
  assert.equal(body.ops[1].name, "LegacyType");
  assert.equal(body.ops[2].op, "remove_relation");
  assert.equal(body.ops[2].name, "OLD_REL");
  await client.close();
});

test("lbb_configure evolve_ontology rejects an op outside the union", async () => {
  const client = await connect(async () => ok());
  const result = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "evolve_ontology",
      ops: [{ op: "delete_everything" }],
    },
  });
  assert.equal(result.isError, true);
  await client.close();
});

test("lbb_configure rejects an empty schema publication", async () => {
  const client = await connect(async () => ok());

  const emptyPublish = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "publish_schema" },
  });
  assert.equal(emptyPublish.isError, true);
  assert.match(
    (emptyPublish.content as { type: string; text: string }[])[0].text,
    /SHACL shapes source/,
  );

  await client.close();
});

test("lbb_commit derives stable idempotency keys and honors explicit overrides", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ committed: 1 });
  };
  const client = await connect(fetch);
  const args = {
    graph: "crm",
    triplets: [
      {
        source: { type: "Organization", name: "Acme" },
        relation: "HAS_CATEGORY",
        target: { type: "Category", name: "Fintech" },
      },
    ],
  };
  await client.callTool({ name: "lbb_commit", arguments: args });
  await client.callTool({ name: "lbb_commit", arguments: args });
  await client.callTool({
    name: "lbb_commit",
    arguments: { ...args, graph: "crm2" },
  });
  await client.callTool({
    name: "lbb_commit",
    arguments: {
      ...args,
      idempotency_key: "manual-key",
      edge_idempotency: "append",
    },
  });

  const key0 = calls[0].init.headers?.["idempotency-key"];
  const key1 = calls[1].init.headers?.["idempotency-key"];
  const key2 = calls[2].init.headers?.["idempotency-key"];
  const key3 = calls[3].init.headers?.["idempotency-key"];
  assert.match(key0 ?? "", /^mcp\.commit:[0-9a-f]{64}$/);
  assert.equal(key1, key0);
  assert.notEqual(key2, key0);
  assert.equal(key3, "manual-key");
  assert.match(calls[0].input, /graph=crm/);
  assert.doesNotMatch(calls[0].input, /graph=g(&|$)/);
  assert.equal(
    JSON.parse(calls[0].init.body ?? "{}").edge_idempotency,
    "append",
  );
  assert.equal(
    JSON.parse(calls[3].init.body ?? "{}").edge_idempotency,
    "append",
  );
  await client.close();
});

test("lbb_commit mode=retract removes facts via the retract route", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ retracted_edges: 0, retracted_entities: 1, commit_seq: 3 });
  };
  // LBB_MCP_DESTRUCTIVE=allow: the retract goes through without a question.
  const client = await connect(fetch, { destructiveWithoutApproval: "allow" });
  await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "retract",
      graph: "crm",
      retract_entities: [{ type: "Person", name: "Garen" }],
    },
  });
  assert.match(calls[0].input, /\/v1\/graph\/retract/);
  assert.match(calls[0].input, /graph=crm/);
  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.deepEqual(body.entities, [{ type: "Person", name: "Garen" }]);
  assert.ok(
    calls[0].init.headers?.["idempotency-key"],
    "retract gets a derived idempotency key",
  );
  await client.close();
});

test("lbb_commit mode=search_feedback writes relevance labels", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      accepted: 1,
      commit_seq: 1,
      visibility_token: "@1",
      idempotent_replay: false,
    });
  };
  const client = await connect(fetch);
  await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "search_feedback",
      graph: "crm",
      search_feedback: {
        query: "customer identity records",
        search_id: "search_123",
        profile: "ndcg_v1",
        labels: [
          {
            target: {
              kind: "entity",
              entity: { entity_type: "Document", name: "Identity Policy" },
            },
            rank: 1,
            score: 0.92,
            grade: 3,
            split: "train",
          },
        ],
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /\/v1\/search\/feedback\?/);
  assert.match(calls[0].input, /graph=crm/);
  assert.match(
    calls[0].init.headers?.["idempotency-key"] ?? "",
    /^mcp\.commit:[0-9a-f]{64}$/,
  );
  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.equal(body.labels[0].grade, 3);
  assert.equal(body.labels[0].split, "train");
  await client.close();
});

test("lbb_commit search feedback validation returns structured tool errors", async () => {
  const client = await connect(async () => ok());
  const result = await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "search_feedback",
      search_feedback: {
        query: "customer identity records",
        labels: [
          {
            target: {
              kind: "entity",
              entity: { entity_type: "Document", name: "Identity Policy" },
            },
            grade: 4,
          },
        ],
      },
    },
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.content as { type: string; text: string }[])[0].text,
    /grade/,
  );

  const missingFeedback = await client.callTool({
    name: "lbb_commit",
    arguments: { mode: "search_feedback" },
  });
  assert.equal(missingFeedback.isError, true);
  assert.match(
    (missingFeedback.content as { type: string; text: string }[])[0].text,
    /requires search_feedback/,
  );

  const factsWithFeedback = await client.callTool({
    name: "lbb_commit",
    arguments: {
      mode: "facts",
      search_feedback: {
        query: "customer identity records",
        labels: [
          {
            target: {
              kind: "entity",
              entity: { entity_type: "Document", name: "Identity Policy" },
            },
            grade: 3,
          },
        ],
      },
    },
  });
  assert.equal(factsWithFeedback.isError, true);
  assert.match(
    (factsWithFeedback.content as { type: string; text: string }[])[0].text,
    /facts mode cannot include search_feedback/,
  );
  await client.close();
});

test("lbb_configure suggest_ontology_change files a suggestion as an agent and never evolves", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ suggestion_id: "sg_1", status: "open" });
  };
  const client = await connect(fetch);

  const result = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "suggest_ontology_change",
      graph: "support",
      title: "Make Contractor a subclass of Person",
      rationale: "12 tickets name contractors as assignees",
      change: [
        {
          op: "add_super_types",
          entity_type: "Contractor",
          super_types: ["Person"],
        },
      ],
      anchor: { kind: "class", name: "Contractor" },
      agent: "triage-bot",
      evidence: { records: 12 },
    },
  });

  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /\/v1\/ontology\/suggestions\?/);
  assert.match(calls[0].input, /graph=support/);
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.equal(body.title, "Make Contractor a subclass of Person");
  assert.deepEqual(body.origin, {
    kind: "agent",
    id: "triage-bot",
    label: "triage-bot",
  });
  assert.deepEqual(body.anchor, { kind: "class", name: "Contractor" });
  assert.equal(body.change[0].op, "add_super_types");
  assert.deepEqual(body.evidence, { records: 12 });
  assert.equal(body.key, undefined, "the server derives the key");
  await client.close();
});

test("lbb_configure suggest_ontology_change takes up to 128 operations, as the server does", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ suggestion_id: "sg_1", status: "open" });
  };
  const client = await connect(fetch);
  const ops = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      op: "add_entity_type",
      name: `Type${i}`,
    }));

  const largest = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "suggest_ontology_change",
      title: "Add 128 classes",
      change: ops(128),
    },
  });
  assert.notEqual(largest.isError, true);
  assert.equal(JSON.parse(calls[0].init.body ?? "{}").change.length, 128);

  const tooMany = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "suggest_ontology_change",
      title: "Add 129 classes",
      change: ops(129),
    },
  });
  assert.equal(tooMany.isError, true);
  assert.equal(calls.length, 1, "a refused call sends no request");
  await client.close();
});

test("lbb_configure lists starters with their status and applies one with a dry run", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(
      calls.length === 1
        ? {
            ontology_version: 3,
            starters: [{ id: "crm", status: { state: "absent" } }],
          }
        : { starter: "crm", dry_run: true, no_op: false, applied_ops: [] },
    );
  };
  const client = await connect(fetch);

  const listed = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "list_starters", graph: "sales" },
  });
  const applied = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "apply_starter",
      graph: "sales",
      starter: "crm",
      dry_run: true,
      expected_ontology_version: 3,
    },
  });

  assert.notEqual(listed.isError, true);
  assert.notEqual(applied.isError, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].input, /\/v1\/ontology\/starters\?graph=sales$/);
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[1].input, /\/v1\/ontology\/starters\/apply\?graph=sales$/);
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body ?? "{}"), {
    starter: "crm",
    dry_run: true,
    expected_ontology_version: 3,
  });
  assert.match(JSON.stringify(listed.content), /absent/);
  await client.close();
});

test("lbb_configure apply_starter requires a starter id", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({});
  });
  const result = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "apply_starter", graph: "sales" },
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  await client.close();
});

test("lbb_inspect ontology_suggestions lists by status", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      ontology_version: 3,
      counts: { open: 1, accepted: 0, dismissed: 0, superseded: 0 },
      suggestions: [],
      truncated: false,
    });
  };
  const client = await connect(fetch);

  await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "ontology_suggestions", status: "open" },
  });

  assert.match(calls[0].input, /\/v1\/ontology\/suggestions\?/);
  assert.match(calls[0].input, /status=open/);
  assert.match(calls[0].input, /limit=50/);
  assert.equal(calls[0].init.method, "GET");
  await client.close();
});

test("lbb_inspect ontology_suggestions shows how many facts each review item commits", async () => {
  const client = await connect(async () =>
    ok({
      ontology_version: 3,
      counts: { open: 1, accepted: 0, dismissed: 0, superseded: 0 },
      suggestions: [
        {
          suggestion_id: "sg_1",
          key: "starter:rooms/r-1-04",
          status: "open",
          title: "Link room R 1.04",
          anchor: { kind: "ontology" },
          origin: { kind: "agent", id: "starter:rooms" },
          change: [],
          identity_count: 0,
          fact_count: 3,
          comment_count: 0,
          revision: 1,
          created_at: "2026-10-09T10:00:00Z",
          updated_at: "2026-10-09T10:00:00Z",
        },
      ],
      truncated: false,
    }),
  );

  const result = await client.callTool({
    name: "lbb_inspect",
    arguments: { action: "ontology_suggestions" },
  });

  assert.notEqual(result.isError, true);
  const listed = payload(result).data as {
    suggestions: { fact_count: number }[];
  };
  assert.equal(listed.suggestions[0]?.fact_count, 3);
  await client.close();
});

test("lbb_configure suggest_ontology_change files graph facts for review without a change", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ suggestion_id: "sg_1", status: "open" });
  });
  const facts = {
    triplets: [
      {
        source: { type: "Room", name: "R 1.04" },
        relation: "HAS_COMPONENT",
        target: { type: "Component", name: "Fire door T30" },
        confidence: 0.62,
        evidence: { text: "Tür T30 RS", source_id: "doc:plan-104" },
      },
    ],
    replace_owned: {
      subjects: [{ type: "Room", name: "R 1.04" }],
      relations: ["HAS_COMPONENT"],
    },
    summary: "One component of room R 1.04",
  };

  const filed = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "suggest_ontology_change",
      title: "Link room R 1.04",
      agent: "starter:rooms",
      key: "starter:rooms/r-1-04",
      facts,
    },
  });
  assert.notEqual(filed.isError, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body ?? "{}");
  assert.deepEqual(body.change, []);
  assert.deepEqual(body.facts, facts);
  assert.equal(body.key, "starter:rooms/r-1-04");

  const empty = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "suggest_ontology_change", title: "Nothing" },
  });
  assert.equal(empty.isError, true);
  assert.match(
    (empty.content as { type: string; text: string }[])[0].text,
    /needs change, facts, or both/,
  );
  const unknownField = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "suggest_ontology_change",
      title: "Link",
      facts: { ...facts, commit: true },
    },
  });
  assert.equal(unknownField.isError, true);
  assert.equal(calls.length, 1, "a refused call sends no request");
  await client.close();
});

test("lbb_evals label judges one result, or the answer of a question as a whole", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ trace: { trace_id: "t1" }, labeled: 1 });
  });

  for (const args of [
    { item: "e:1", valid: true },
    { valid: true, by: "agent" },
    { valid: false, sparql: "SELECT ?f WHERE { ?f a <urn:Finding> }" },
    { valid: false, note: "The user says the answer is wrong." },
  ]) {
    const result = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "label", trace_id: "t1", ...args },
    });
    assert.notEqual(result.isError, true, JSON.stringify(args));
  }
  assert.equal(new URL(calls[0].input).pathname, "/v1/evals/label");
  assert.equal(new URL(calls[0].input).searchParams.get("trace"), "t1");
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.init.body ?? "{}")),
    [
      { item: "e:1", valid: true },
      { valid: true, by: "agent" },
      { valid: false, sparql: "SELECT ?f WHERE { ?f a <urn:Finding> }" },
      { valid: false, note: "The user says the answer is wrong." },
    ],
  );

  // A label that names nothing, and a right query outside an answer marked
  // wrong, stop before any request.
  for (const args of [
    {},
    { item: "e:1" },
    { valid: true, sparql: "ASK { ?s ?p ?o }" },
    { item: "e:1", valid: false, sparql: "ASK { ?s ?p ?o }" },
  ]) {
    const result = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "label", trace_id: "t1", ...args },
    });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 4);
  await client.close();
});

test("lbb_evals label names the route of a question with an answer label", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ trace: { trace_id: "t1" }, labeled: 0 });
  });
  const named = await client.callTool({
    name: "lbb_evals",
    arguments: {
      action: "label",
      trace_id: "t1",
      valid: true,
      route: "aggregate",
    },
  });
  assert.notEqual(named.isError, true);
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
    valid: true,
    route: "aggregate",
  });
  // A route goes with an answer label that names the query.
  for (const args of [
    { valid: false, route: "lookup" },
    { item: "e:1", valid: true, route: "lookup" },
  ]) {
    const result = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "label", trace_id: "t1", ...args },
    });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 1);
  await client.close();
});

test("lbb_evals run_answers sends the app's answers and results reads its series", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ results: { runner: "my-agent", verdicts: {} } });
  });
  const answers = [
    {
      golden: "g1",
      sparql: "ASK { ?s ?p ?o }",
      route: { kind: "lookup", confidence: 0.75, by: "router" },
    },
    { golden: "g2", error: "the model timed out" },
  ];
  const ran = await client.callTool({
    name: "lbb_evals",
    arguments: {
      action: "run_answers",
      runner: "my-agent",
      consistency: "strong",
      answers,
    },
  });
  assert.notEqual(ran.isError, true);
  const listed = await client.callTool({
    name: "lbb_evals",
    arguments: { action: "results", runner: "my-agent" },
  });
  assert.notEqual(listed.isError, true);
  const [run, results] = calls.map((call) => new URL(call.input));
  assert.equal(calls[0].init.method, "POST");
  assert.equal(run.pathname, "/v1/evals/run/answers");
  assert.equal(run.searchParams.get("consistency"), "strong");
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
    answers,
    runner: "my-agent",
  });
  assert.equal(results.pathname, "/v1/evals/results");
  assert.equal(results.searchParams.get("runner"), "my-agent");

  const empty = await client.callTool({
    name: "lbb_evals",
    arguments: { action: "run_answers", answers: [] },
  });
  assert.equal(empty.isError, true);
  assert.equal(calls.length, 2, "a refused call sends no request");
  await client.close();
});

test("lbb_evals review_check agrees with the judge or corrects it", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      call: "c1",
      truth: { verdict: "wrong", score: 0, by: "person" },
    });
  };
  const client = await connect(fetch);

  const agreed = await client.callTool({
    name: "lbb_evals",
    arguments: { action: "review_check", call_id: "c1", agree: true },
  });
  const corrected = await client.callTool({
    name: "lbb_evals",
    arguments: {
      action: "review_check",
      call_id: "c1",
      agree: false,
      verdict: "wrong",
      reference: { grades: { "https://x.test/e/a": 0 } },
      note: "The user confirmed: the hits are about returns.",
      graph: "crm",
    },
  });

  assert.notEqual(agreed.isError, true);
  assert.notEqual(corrected.isError, true);
  const [first, second] = calls.map((call) => new URL(call.input));
  assert.equal(calls[0].init.method, "POST");
  assert.equal(first.pathname, "/v1/models/checks/review");
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    graph: "g",
    id: "c1",
  });
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), { agree: true });
  assert.equal(second.searchParams.get("graph"), "crm");
  assert.deepEqual(JSON.parse(calls[1].init.body ?? "{}"), {
    agree: false,
    verdict: "wrong",
    reference: { grades: { "https://x.test/e/a": 0 } },
    note: "The user confirmed: the hits are about returns.",
  });
  await client.close();
});

test("lbb_evals review_check refuses an incomplete review before any request", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({});
  });
  for (const args of [
    { agree: true },
    { call_id: "c1" },
    { call_id: "c1", agree: false },
    { call_id: "c1", agree: true, verdict: "wrong" },
    { call_id: "c1", agree: false, verdict: "wrong", score: 2 },
  ]) {
    const result = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "review_check", ...args },
    });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  await client.close();
});

test("lbb_model_choice_manage sets and removes a model choice", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ id: "mch_1", object: "model_choice", use: "extract" });
  };
  const client = await connect(fetch);

  const chosen = await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: {
      action: "put_choice",
      use: "extract",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "low",
      workflow: "products",
    },
  });
  await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: { action: "delete_choice", use: "decide", graph: "crm" },
  });
  const noModel = await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: { action: "put_choice", use: "extract" },
  });
  await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: {
      action: "put_choice",
      use: "extract",
      provider: "mock",
      model: "mock-candidate",
      workflow: "products",
      experiment: "exp_1791967648726a1b2c3d4e5f6",
    },
  });

  assert.notEqual(chosen.isError, true);
  assert.equal(noModel.isError, true);
  assert.deepEqual(
    calls.map((call) => {
      const url = new URL(call.input);
      return `${call.init.method} ${url.pathname}?${url.searchParams}`;
    }),
    [
      "PUT /v1/models/choices?graph=g",
      "DELETE /v1/models/choices?graph=crm&use=decide",
      "PUT /v1/models/choices?graph=g",
    ],
  );
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
    use: "extract",
    model: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" },
    workflow: "products",
  });
  // A choice that applies an experiment's B names the experiment.
  assert.deepEqual(JSON.parse(calls[2].init.body ?? "{}"), {
    use: "extract",
    model: { provider: "mock", model: "mock-candidate" },
    workflow: "products",
    experiment: "exp_1791967648726a1b2c3d4e5f6",
  });
});

test("lbb_model_choice_manage starts, stops, switches and reverts", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ trials: [], switches: [] });
  };
  const client = await connect(fetch);

  const started = await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: {
      action: "start",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "low",
      jobs: ["ask"],
      target: 20,
    },
  });
  await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: { action: "stop", trial_id: "t1" },
  });
  await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: { action: "switch", trial_id: "t1", graph: "crm" },
  });
  await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: { action: "revert", job: "ask" },
  });
  const noModel = await client.callTool({
    name: "lbb_model_choice_manage",
    arguments: { action: "start", provider: "anthropic" },
  });

  assert.notEqual(started.isError, true);
  assert.equal(noModel.isError, true);
  assert.deepEqual(
    calls.map((call) => {
      const url = new URL(call.input);
      return `${call.init.method} ${url.pathname}?${url.searchParams}`;
    }),
    [
      "POST /v1/models/trials?graph=g",
      "POST /v1/models/trials/stop?graph=g&id=t1",
      "POST /v1/models/switches?graph=crm",
      "POST /v1/models/switches/revert?graph=g&job=ask",
    ],
  );
  assert.deepEqual(JSON.parse(calls[0].init.body ?? "{}"), {
    candidate: {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "low",
    },
    jobs: ["ask"],
    target: 20,
  });
  assert.deepEqual(JSON.parse(calls[2].init.body ?? "{}"), { trial: "t1" });
  await client.close();
});

test("0.15.1-shaped inputs still pass: null optional fields and fields the server ignores", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ commit_seq: 1 });
  });
  try {
    const committed = await client.callTool({
      name: "lbb_commit",
      arguments: {
        triplets: [
          {
            source: { type: "Organization", name: "Acme" },
            relation: "HAS_CATEGORY",
            target: { type: "Category", name: "Fintech" },
            evidence: {
              text: "Acme is a fintech.",
              source_id: null,
              observation_id: null,
              region: null,
              page_hint: 3,
            },
          },
          {
            source: { type: "Organization", name: "Beta" },
            relation: "HAS_CATEGORY",
            target: { type: "Category", name: "Fintech" },
            evidence: null,
          },
        ],
        entity_embeddings: [
          {
            type: "Organization",
            name: "Acme",
            key: null,
            entity_id: null,
            metric: null,
            model_id: "m",
            vector: [0.1, 0.2],
            normalized: true,
          },
        ],
      },
    });
    assert.notEqual(committed.isError, true, JSON.stringify(committed));
    const body = JSON.parse(calls[0].init.body ?? "{}");
    // Nulls and fields the server does not know go to it as sent; it
    // ignores those fields.
    assert.deepEqual(body.triplets[0].evidence, {
      text: "Acme is a fintech.",
      source_id: null,
      observation_id: null,
      region: null,
      page_hint: 3,
    });
    assert.equal(body.triplets[1].evidence, null);
    assert.deepEqual(body.entity_embeddings[0], {
      type: "Organization",
      name: "Acme",
      key: null,
      entity_id: null,
      metric: null,
      model_id: "m",
      vector: [0.1, 0.2],
      normalized: true,
    });

    const feedback = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "search_feedback",
        search_feedback: {
          query: "fintech",
          profile: null,
          labels: [
            {
              target: {
                kind: "entity",
                entity: { entity_type: "Organization", name: "Acme" },
              },
              grade: 3,
            },
          ],
        },
      },
    });
    assert.notEqual(feedback.isError, true, JSON.stringify(feedback));

    const suggested = await client.callTool({
      name: "lbb_configure",
      arguments: {
        action: "suggest_ontology_change",
        title: "Add Fintech facts",
        facts: {
          triplets: [
            {
              source: { type: "Organization", name: "Acme", key: null },
              relation: "HAS_CATEGORY",
              target: { type: "Category", name: "Fintech", key: null },
              evidence: { text: "Acme is a fintech.", source_id: null },
            },
          ],
        },
      },
    });
    assert.notEqual(suggested.isError, true, JSON.stringify(suggested));
    const facts = JSON.parse(calls.at(-1)?.init.body ?? "{}").facts;
    assert.equal(facts.triplets[0].source.key, null);
    assert.equal(facts.triplets[0].evidence.source_id, null);
  } finally {
    await client.close();
  }
});
