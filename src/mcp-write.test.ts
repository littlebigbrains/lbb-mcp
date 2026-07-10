import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike } from "@littlebigbrain/client";
import { connect, ok, type Call } from "./test-support.js";

test("lbb_configure defines ontologies, publishes schemas, and stores rules", async () => {
  const calls: Call[] = [];
  const shapeSource = "@prefix sh: <http://www.w3.org/ns/shacl#> .";
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
      branch: "draft",
      preview_digest: "sha256:preview",
      desired_mode: "warn",
      confirm_restrictive: true,
      shapes: { source: shapeSource, format: "turtle" },
    },
  });
  await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "define_rules",
      graph: "support",
      branch: "draft",
      rules: [{ name: "knows", body: [], head: {} }],
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
  assert.match(calls[1].input, /branch=draft/);
  const publishBody = JSON.parse(calls[1].init.body ?? "{}");
  assert.equal(publishBody.preview_digest, "sha256:preview");
  assert.equal(publishBody.desired_mode, "warn");
  assert.equal(publishBody.confirm_restrictive, true);
  assert.deepEqual(publishBody.shapes, {
    source: shapeSource,
    format: "turtle",
  });
  assert.match(calls[2].input, /\/v1\/inference\/rules\?/);
  assert.match(calls[2].input, /graph=support/);
  assert.match(calls[2].input, /branch=draft/);
  assert.equal(JSON.parse(calls[2].init.body ?? "{}").rules[0].name, "knows");
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
  const client = await connect(fetch);

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

test("lbb_configure rejects unsafe schema and rule mutations", async () => {
  const client = await connect(async () => ok());

  const missingRules = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "define_rules" },
  });
  assert.equal(missingRules.isError, true);
  assert.match(
    (missingRules.content as { type: string; text: string }[])[0].text,
    /rules/,
  );

  const emptyRules = await client.callTool({
    name: "lbb_configure",
    arguments: { action: "define_rules", rules: [] },
  });
  assert.equal(emptyRules.isError, true);
  assert.match(
    (emptyRules.content as { type: string; text: string }[])[0].text,
    /confirm_empty/,
  );

  const missingShapes = await client.callTool({
    name: "lbb_configure",
    arguments: {
      action: "publish_schema",
      preview_digest: "sha256:preview",
      desired_mode: "warn",
    },
  });
  assert.equal(missingShapes.isError, true);
  assert.match(
    (missingShapes.content as { type: string; text: string }[])[0].text,
    /shapes/,
  );
  await client.close();
});

test("lbb_branch merge posts the WS16 merge with an idempotency key", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      merged: true,
      commits_applied: 1,
      snapshot: { commit_seq: 3, indexed_seq: 0 },
    });
  };
  const client = await connect(fetch);
  await client.callTool({
    name: "lbb_branch",
    arguments: { action: "merge", from_branch: "scratch", delete_source: true },
  });
  assert.match(calls[0].input, /\/v1\/graph\/branch\/merge\?/);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.from_branch, "scratch");
  assert.equal(body.validate, true);
  assert.equal(body.delete_source, true);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(
    headers["idempotency-key"],
    "merge is a write and must carry a key",
  );

  const forkCalls: Call[] = [];
  const forkFetch: FetchLike = async (input, init) => {
    forkCalls.push({ input, init: init ?? {} });
    return ok({ graph: {}, parent: {}, snapshot: {} });
  };
  const forker = await connect(forkFetch);
  await forker.callTool({
    name: "lbb_branch",
    arguments: { action: "create", from_branch: "main", branch: "scratch" },
  });
  assert.match(forkCalls[0].input, /\/v1\/graph\/branch\?/);
  assert.match(forkCalls[0].input, /branch=scratch/);
  assert.equal(JSON.parse(String(forkCalls[0].init.body)).from_branch, "main");
  await forker.close();
  await client.close();
});

test("lbb_observe posts the episode + facts with an idempotency key", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({
      episode_id: "abc",
      branch: "observe-x",
      facts: [],
      merged: false,
      snapshot: {},
    });
  };
  const client = await connect(fetch);
  await client.callTool({
    name: "lbb_observe",
    arguments: {
      session_id: "sess-1",
      turns: [{ role: "user", content: "remember: svc-b depends on svc-c" }],
      facts: [
        {
          fact: "svc-b depends on svc-c",
          confidence: 0.9,
          triplet: {
            source: { type: "SERVICE", name: "svc-b" },
            relation: "DEPENDS_ON",
            target: { type: "SERVICE", name: "svc-c" },
          },
        },
      ],
      auto_merge: true,
    },
  });
  assert.match(calls[0].input, /\/v1\/memory\/observe\?/);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.episode.session_id, "sess-1");
  assert.equal(body.episode.turns.length, 1);
  assert.equal(
    body.extraction.byo_completion[0].fact,
    "svc-b depends on svc-c",
  );
  assert.equal(body.auto_merge, true);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(
    headers["idempotency-key"],
    "observe is a write and must carry a key",
  );
  await client.close();
});

test("lbb_index runs the persisted index build", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ indexed: true });
  };
  const client = await connect(fetch);
  await client.callTool({ name: "lbb_index", arguments: { background: true } });
  assert.match(calls[0].input, /\/v1\/index\/run\?/);
  assert.match(calls[0].input, /background=true/);
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
  const client = await connect(fetch);
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
      branch: "main",
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
  assert.match(calls[0].input, /branch=main/);
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
