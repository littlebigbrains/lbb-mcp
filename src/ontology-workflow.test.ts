import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, ok, payload, type Call } from "./test-support.js";

test("ontology and schema inspection page every complete entry beyond the output cap", async () => {
  for (const action of ["ontology", "schema"]) {
    const original = {
      graph: { graph_id: "crm", branch_id: "main" },
      ontology_version: 11,
      [action === "ontology" ? "entity_type_defs" : "classes"]: Array.from(
        { length: 84 },
        (_, i) => ({
          name: `Class${i}`,
          super_types: ["Agent"],
          description: "complete ".repeat(700),
        }),
      ),
      relations: Array.from({ length: 138 }, (_, i) => ({
        name: `relation${i}`,
        src_types: Array.from({ length: 150 }, (_, n) => `Class${n}`),
      })),
      property_defs: Array.from({ length: 265 }, (_, i) => ({
        name: `property${i}`,
        value_type: "text",
      })),
    };
    const client = await connect(async () => ok(original));
    try {
      let args: Record<string, unknown> = {
        action,
        graph: "crm",
        detail: "full",
        page_size: 100,
      };
      const collected: Record<string, unknown[]> = {};
      let pages = 0;
      do {
        const result = await client.callTool({
          name: "lbb_inspect",
          arguments: args,
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const p = payload(result);
        assert.ok(
          JSON.stringify(result.structuredContent, null, 2).length <= 80_000,
        );
        assert.equal(p.truncated, undefined);
        for (const [k, v] of Object.entries(
          p.data as Record<string, unknown>,
        )) {
          if (Array.isArray(v)) (collected[k] ??= []).push(...v);
        }
        args = p.next ?? {};
        assert.ok(++pages < 100, "cursor must make progress");
      } while (args.cursor);
      for (const [k, v] of Object.entries(original))
        if (Array.isArray(v)) assert.deepEqual(collected[k], v);
      assert.ok(pages > 5);
    } finally {
      await client.close();
    }
  }
});

test("metadata continuations reject cross-scope reuse and schema drift", async () => {
  let version = 1;
  let reads = 0;
  const client = await connect(async () => {
    reads++;
    return ok({
      ontology_version: version,
      entity_type_defs: [{ name: "A" }, { name: "B" }],
    });
  });
  try {
    const first = payload(
      await client.callTool({
        name: "lbb_inspect",
        arguments: {
          action: "ontology",
          graph: "crm",
          page_size: 1,
          section: "entity_type_defs",
        },
      }),
    );
    const count = reads;
    for (const override of [
      { graph: "other" },
      { action: "schema" },
      { section: "relations" },
      { page_size: 2 },
    ]) {
      const result = await client.callTool({
        name: "lbb_inspect",
        arguments: { ...first.next, ...override },
      });
      assert.equal(result.isError, true);
    }
    assert.equal(reads, count);
    version++;
    const changed = await client.callTool({
      name: "lbb_inspect",
      arguments: first.next,
    });
    assert.equal(changed.isError, true);
    assert.match(JSON.stringify(changed), /changed during pagination/);
  } finally {
    await client.close();
  }
});

test("configuration and fact previews forward real non-mutating server options", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ dry_run: true, activated: false });
  });
  try {
    for (const args of [
      {
        action: "define_ontology",
        graph: "crm",
        entity_types: [
          { name: "Person", super_types: ["Agent"] },
          { name: "Agent" },
        ],
        relations: [{ name: "KNOWS" }],
      },
      {
        action: "evolve_ontology",
        graph: "crm",
        ops: [
          {
            op: "add_super_types",
            entity_type: "Person",
            super_types: ["Agent"],
          },
        ],
      },
      {
        action: "publish_schema",
        graph: "crm",
        shapes: {
          format: "turtle",
          source: "<urn:shape> a <http://www.w3.org/ns/shacl#NodeShape> .",
        },
      },
    ]) {
      const result = await client.callTool({
        name: "lbb_configure",
        arguments: { ...args, dry_run: true },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }
    assert.equal(JSON.parse(calls[0].init.body ?? "{}").dry_run, true);
    assert.deepEqual(
      JSON.parse(JSON.parse(calls[0].init.body ?? "{}").source).entity_types[0]
        .super_types,
      ["Agent"],
    );
    for (const call of calls.slice(1))
      assert.equal(new URL(call.input).searchParams.get("dry_run"), "true");
    assert.equal(
      JSON.parse(calls[1].init.body ?? "{}").ops[0].op,
      "add_super_types",
    );
    const result = await client.callTool({
      name: "lbb_commit",
      arguments: {
        mode: "facts",
        dry_run: true,
        entity_properties: [
          { type: "Person", name: "Ada", properties: { display_name: "Ada" } },
        ],
      },
    });
    assert.notEqual(result.isError, true);
    assert.match(calls[3].input, /dry_run=true/);
    assert.equal(calls[3].init.headers?.["idempotency-key"], undefined);
  } finally {
    await client.close();
  }
});

test("RDF import and edits preserve OWL text, scope and retry identity through MCP", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return input.includes("/update")
      ? { ok: true, status: 204, text: async () => "" }
      : ok({ triples_read: 5 });
  });
  const source =
    "@prefix owl: <http://www.w3.org/2002/07/owl#> . <urn:Person> a owl:Class ; owl:equivalentClass [ owl:intersectionOf (<urn:Agent> <urn:Contact>) ] .";
  try {
    for (const detail of ["compact", "full"]) {
      const result = await client.callTool({
        name: "lbb_rdf",
        arguments: {
          action: "import",
          graph: "crm",
          branch: "draft",
          format: "turtle",
          source,
          detail,
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }
    assert.equal(calls[0].init.body, source);
    assert.equal(calls[0].init.headers?.["content-type"], "text/turtle");
    assert.equal(
      calls[0].init.headers?.["idempotency-key"],
      calls[1].init.headers?.["idempotency-key"],
    );
    assert.equal(new URL(calls[0].input).searchParams.get("graph_uri"), null);
    assert.equal(new URL(calls[0].input).searchParams.get("branch"), "draft");
    const update =
      'INSERT DATA { <urn:Person> <http://www.w3.org/2000/01/rdf-schema#label> "Person" }';
    const result = await client.callTool({
      name: "lbb_rdf",
      arguments: {
        action: "update",
        graph: "crm",
        update,
        idempotency_key: "ontology-label-v2",
      },
    });
    assert.notEqual(result.isError, true);
    assert.equal(calls[2].init.body, update);
    assert.match(calls[2].input, /\/update\?graph=crm/);
    assert.equal(
      calls[2].init.headers?.["content-type"],
      "application/sparql-update",
    );
    assert.equal(
      calls[2].init.headers?.["idempotency-key"],
      "ontology-label-v2",
    );
  } finally {
    await client.close();
  }
});

test("OWL and read-after-write query controls survive pagination and reject changes", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/metadata"))
      return ok({ snapshot: { commit_seq: 49 } });
    const offset = JSON.parse(init?.body ?? "{}").offset;
    return ok({
      results: JSON.stringify({
        head: { vars: ["person"] },
        results: { bindings: [{ person: { type: "uri", value: "urn:ada" } }] },
      }),
      row_page: {
        returned: 1,
        total: 2,
        offset,
        limit: 1,
        has_more: offset === 0,
        next_offset: 1,
      },
    });
  });
  try {
    const first = payload(
      await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "sparql",
          query:
            "SELECT ?person WHERE { ?person a <urn:Agent> } ORDER BY ?person",
          entailment: "owl",
          consistency: "strong",
          min_indexed_seq: 49,
          row_limit: 1,
        },
      }),
    );
    assert.ok(first.next?.cursor);
    const second = await client.callTool({
      name: "lbb_query",
      arguments: first.next,
    });
    assert.notEqual(second.isError, true, JSON.stringify(second));
    for (const call of calls.filter((c) => c.input.includes("sparql-text"))) {
      assert.equal(JSON.parse(call.init.body ?? "{}").entailment, "owl");
      assert.equal(JSON.parse(call.init.body ?? "{}").as_of_commit_seq, 49);
      assert.equal(
        new URL(call.input).searchParams.get("consistency"),
        "strong",
      );
      assert.equal(
        new URL(call.input).searchParams.get("min_indexed_seq"),
        "49",
      );
    }
    const before = calls.length;
    const rejected = await client.callTool({
      name: "lbb_query",
      arguments: { ...first.next, entailment: "none" },
    });
    assert.equal(rejected.isError, true);
    assert.equal(calls.length, before);
  } finally {
    await client.close();
  }
});

test("guide provides bootstrap instructions on an empty stack", async () => {
  const client = await connect(async (input) =>
    input.includes("/summary")
      ? {
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({
              error: {
                code: "graph_not_found",
                message: "graph 'main' does not exist",
              },
            }),
        }
      : ok({ data: [] }),
  );
  try {
    const result = await client.callTool({
      name: "lbb_inspect",
      arguments: { action: "guide", detail: "full" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(
      (payload(result).data as { graph_exists: boolean }).graph_exists,
      false,
    );
    assert.match(JSON.stringify(result), /lbb_rdf/);
  } finally {
    await client.close();
  }
});

test("an oversized individual definition is losslessly readable in MCP fragments", async () => {
  const definition = {
    name: "Huge",
    description: '\\"🧠\n'.repeat(50_000),
    properties: [{ name: "preserved" }],
  };
  const client = await connect(async () =>
    ok({
      ontology_version: 1,
      entity_type_defs: [definition, { name: "After" }],
    }),
  );
  try {
    let args: Record<string, unknown> = { action: "ontology" };
    let serialized = "";
    let sawFollowing = false;
    let pages = 0;
    do {
      const result = await client.callTool({
        name: "lbb_inspect",
        arguments: args,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(
        JSON.stringify(result.structuredContent, null, 2).length <= 80_000,
      );
      const p = result.structuredContent as {
        data: { entity_type_defs: unknown[] };
        next?: Record<string, unknown>;
        entry_fragment?: {
          char_offset: number;
          serialized_json: string;
          complete: boolean;
        };
      };
      if (p.entry_fragment) {
        assert.equal(p.entry_fragment.char_offset, serialized.length);
        serialized += p.entry_fragment.serialized_json;
        if (p.entry_fragment.complete)
          assert.deepEqual(JSON.parse(serialized), definition);
      } else {
        assert.deepEqual(p.data.entity_type_defs, [{ name: "After" }]);
        sawFollowing = true;
      }
      args = p.next ?? {};
      assert.ok(++pages < 100);
    } while (args.cursor);
    assert.ok(sawFollowing);
    assert.deepEqual(JSON.parse(serialized), definition);
  } finally {
    await client.close();
  }
});
