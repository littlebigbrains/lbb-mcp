import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FetchLike } from "@littlebigbrain/client";
import type { LbbServerOptions, McpToolCallEvent } from "./query-observer.js";
import { connect, ok, sent, type Call } from "./test-support.js";

type Asked = ElicitRequest["params"];

/**
 * A server with a fake fetch and a client that answers each approval with
 * `answer` (none: a client without elicitation).
 */
async function setup(
  answer?: ElicitResult,
  options?: LbbServerOptions,
  fetch?: FetchLike,
) {
  const calls: Call[] = [];
  const asked: Asked[] = [];
  const client = await connect(
    async (input, init) => {
      calls.push({ input, init: init ?? {} });
      return fetch ? fetch(input, init) : ok({ deleted: true });
    },
    options,
    answer
      ? (params) => {
          asked.push(params);
          return answer;
        }
      : undefined,
  );
  return { client, calls, asked };
}

const approve: ElicitResult = { action: "accept", content: { confirm: true } };

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (
    result.structuredContent as { error: { code: string; message: string } }
  ).error;
}

/** The requests that write: everything but a read. */
function writes(calls: Call[]): Call[] {
  return calls.filter((call) => (call.init.method ?? "GET") !== "GET");
}

const deletes = [
  {
    name: "lbb_embeddings_delete",
    arguments: { name: "service" },
    route: /^DELETE http:\/\/h\/v1\/embeddings\?.*name=service&confirm=service/,
    asks: /^Delete the embedding "service" of graph "g" and its vectors\?/,
  },
  {
    name: "lbb_fit_sources_delete",
    arguments: { name: "interview", graph: "notes" },
    route:
      /^DELETE http:\/\/h\/v1\/ontology\/fit-sources\?.*graph=notes.*name=interview&confirm=interview/,
    asks: /^Delete the fit source "interview" of graph "notes"\?/,
  },
  {
    name: "lbb_workflows_delete",
    arguments: { starter: "ontology.fit", name: "interview" },
    route:
      /^DELETE http:\/\/h\/v1\/workflows\/triggered\?.*starter=ontology\.fit&name=interview&confirm=interview/,
    asks: /^Delete the ontology\.fit workflow "interview" of graph "g"\?/,
  },
  {
    name: "lbb_workflows_delete",
    arguments: { starter: "search.embed", name: "service" },
    route:
      /^DELETE http:\/\/h\/v1\/workflows\/triggered\?.*starter=search\.embed&name=service/,
    asks: /with its embedding and vectors/,
  },
  {
    name: "lbb_workflows_delete",
    arguments: { name: "areas" },
    route:
      /^DELETE http:\/\/h\/v1\/workflows\/named\?.*name=areas&confirm=areas/,
    asks: /^Delete the workflow with triggers "areas" of graph "g"\? Its shards stay\.$/,
  },
];

const retract = {
  mode: "retract",
  graph: "crm",
  retract_edges: [
    {
      source: { type: "Organization", name: "Acme" },
      relation: "HAS_CATEGORY",
      target: { type: "Category", name: "Fintech" },
    },
  ],
  retract_entities: [{ type: "Organization", name: "Beta" }],
};

const removingUpdate =
  'DELETE DATA { <https://example.com/a> <https://example.com/name> "A" }';

const removing = {
  action: "evolve_ontology",
  graph: "crm",
  ops: [
    { op: "add_property", name: "status" },
    { op: "remove_entity_type", name: "Lead" },
    { op: "remove_relation", name: "OWNS" },
    {
      op: "narrow_relation",
      relation: "WORKS_AT",
      remove_domain: ["Person"],
      remove_range: ["Company", "Startup"],
    },
  ],
};

const shapes = {
  format: "turtle",
  source:
    "@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix dclass: <https://littlebigbrain.com/class/> . <https://example.org/shapes/Ticket> a sh:NodeShape ; sh:targetClass dclass:ticket .",
};

/** Every destructive call, each as the agent sends it. */
const destructive = [
  ...deletes.map(({ name, arguments: args }) => ({ name, arguments: args })),
  { name: "lbb_commit", arguments: retract },
  { name: "lbb_rdf", arguments: { action: "update", update: removingUpdate } },
  { name: "lbb_configure", arguments: removing },
  {
    name: "lbb_configure",
    arguments: { action: "publish_schema", desired_mode: "reject", shapes },
  },
];

test("a delete the person approves is sent, with a question that names it", async () => {
  for (const call of deletes) {
    const { client, calls, asked } = await setup(approve);
    try {
      const result = await client.callTool({
        name: call.name,
        arguments: call.arguments,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(asked.length, 1, call.name);
      assert.match(asked[0].message, call.asks);
      assert.equal(asked[0].mode, "form");
      const schema = (
        asked[0] as {
          requestedSchema: {
            properties: Record<string, { type: string }>;
            required: string[];
          };
        }
      ).requestedSchema;
      assert.equal(schema.properties.confirm.type, "boolean");
      assert.deepEqual(schema.required, ["confirm"]);
      assert.equal(calls.length, 1, call.name);
      assert.match(
        `${calls[0].init.method} ${calls[0].input}`,
        call.route,
        call.name,
      );
    } finally {
      await client.close();
    }
  }
});

test("a delete the person declines or cancels sends nothing", async () => {
  for (const answer of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { confirm: false } },
  ] as ElicitResult[]) {
    for (const call of deletes) {
      const { client, calls, asked } = await setup(answer);
      try {
        const result = await client.callTool({
          name: call.name,
          arguments: call.arguments,
        });
        assert.equal(result.isError, true, call.name);
        assert.equal(errorOf(result).code, "approval_declined");
        assert.match(errorOf(result).message, /declined, so nothing was sent/);
        assert.equal(asked.length, 1);
        assert.deepEqual(calls, [], `${call.name} sends nothing`);
      } finally {
        await client.close();
      }
    }
  }
});

test("a client without form elicitation gets approval_required for every destructive call", async () => {
  for (const call of destructive) {
    const { client, calls } = await setup();
    try {
      const result = await client.callTool(call);
      assert.equal(result.isError, true, call.name);
      assert.equal(errorOf(result).code, "approval_required", call.name);
      assert.match(
        errorOf(result).message,
        /cannot ask the person to approve it .*nothing was sent.*in the console or with the TypeScript or Python SDK.*LBB_MCP_DESTRUCTIVE=allow/,
      );
      assert.deepEqual(calls, [], `${call.name} sends nothing`);
    } finally {
      await client.close();
    }
  }
});

test("confirm is no way through: a 0.15 delete with confirm is refused without a question", async () => {
  const { client, calls } = await setup();
  try {
    const result = await client.callTool({
      name: "lbb_embeddings_delete",
      arguments: { name: "service", confirm: "service" },
    });
    assert.equal(errorOf(result).code, "approval_required");
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
  // With elicitation the person is asked, confirm or not.
  const asking = await setup({ action: "decline" });
  try {
    const result = await asking.client.callTool({
      name: "lbb_embeddings_delete",
      arguments: { name: "service", confirm: "service" },
    });
    assert.equal(errorOf(result).code, "approval_declined");
    assert.equal(asking.asked.length, 1);
    assert.deepEqual(asking.calls, []);
  } finally {
    await asking.client.close();
  }
});

test("a client with URL elicitation only cannot be asked, so the call is refused", async () => {
  const calls: Call[] = [];
  let asked = 0;
  const client = await connect(
    async (input, init) => {
      calls.push({ input, init: init ?? {} });
      return ok({});
    },
    undefined,
    () => {
      asked += 1;
      return approve;
    },
    { url: {} },
  );
  try {
    for (const call of destructive) {
      const result = await client.callTool(call);
      assert.equal(errorOf(result).code, "approval_required", call.name);
    }
    assert.equal(asked, 0, "no form is sent to a client without forms");
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("LBB_MCP_DESTRUCTIVE=allow sends a destructive call without a question", async () => {
  for (const call of destructive) {
    const { client, calls } = await setup(undefined, {
      destructiveWithoutApproval: "allow",
    });
    try {
      const result = await client.callTool(call);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(writes(calls).length, 1, call.name);
    } finally {
      await client.close();
    }
  }

  // The server reads the setting from its environment.
  const before = process.env.LBB_MCP_DESTRUCTIVE;
  for (const [value, code] of [
    ["allow", undefined],
    [" Allow ", undefined],
    ["yes", "approval_required"],
    [undefined, "approval_required"],
  ] as const) {
    if (value === undefined) delete process.env.LBB_MCP_DESTRUCTIVE;
    else process.env.LBB_MCP_DESTRUCTIVE = value;
    const { client } = await setup(undefined, {
      destructiveWithoutApproval: undefined,
    });
    try {
      const result = await client.callTool(deletes[0]);
      assert.equal(
        result.isError ? errorOf(result).code : undefined,
        code,
        String(value),
      );
    } finally {
      await client.close();
    }
  }
  if (before === undefined) delete process.env.LBB_MCP_DESTRUCTIVE;
  else process.env.LBB_MCP_DESTRUCTIVE = before;
});

test("an approval request that fails sends nothing", async () => {
  const calls: Call[] = [];
  const client = await connect(
    async (input, init) => {
      calls.push({ input, init: init ?? {} });
      return ok({});
    },
    undefined,
    () => {
      throw new Error("the form could not open");
    },
  );
  try {
    const result = await client.callTool({
      name: "lbb_embeddings_delete",
      arguments: { name: "service" },
    });
    assert.equal(result.isError, true);
    assert.equal(errorOf(result).code, "approval_failed");
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("a retract asks with the counts and each link, and a decline sends nothing", async () => {
  const declined = await setup({ action: "decline" });
  try {
    const result = await declined.client.callTool({
      name: "lbb_commit",
      arguments: retract,
    });
    assert.equal(result.isError, true);
    assert.equal(errorOf(result).code, "approval_declined");
    assert.equal(declined.asked.length, 1);
    assert.equal(
      declined.asked[0].message,
      [
        'Retract 1 link and every current link of 1 record from graph "crm"?',
        "- the link Acme (Organization) HAS_CATEGORY Fintech (Category)",
        "- every current link of Beta (Organization)",
        "The records and their history stay readable in as_of reads.",
      ].join("\n"),
    );
    assert.deepEqual(declined.calls, []);
  } finally {
    await declined.client.close();
  }

  const approved = await setup(approve);
  try {
    const result = await approved.client.callTool({
      name: "lbb_commit",
      arguments: retract,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(approved.calls.length, 1);
    assert.match(approved.calls[0].input, /\/v1\/graph\/retract\?.*graph=crm/);
    assert.match(
      approved.calls[0].init.headers?.["idempotency-key"] ?? "",
      /^mcp\.commit:/,
    );
  } finally {
    await approved.client.close();
  }

  // Facts and feedback are additive: the person is not asked.
  const facts = await setup({ action: "decline" });
  try {
    const result = await facts.client.callTool({
      name: "lbb_commit",
      arguments: {
        triplets: [
          {
            source: { type: "Organization", name: "Acme" },
            relation: "HAS_CATEGORY",
            target: { type: "Category", name: "Fintech" },
          },
        ],
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(facts.asked.length, 0);
    assert.equal(facts.calls.length, 1);
  } finally {
    await facts.client.close();
  }
});

test("a long retract names the first 20 links and counts the rest", async () => {
  const { client, asked } = await setup({ action: "decline" });
  try {
    await client.callTool({
      name: "lbb_commit",
      arguments: {
        retract_entities: Array.from({ length: 23 }, (_, i) => ({
          type: "Person",
          name: `P${i}`,
        })),
      },
    });
    const lines = asked[0].message.split("\n");
    assert.equal(
      lines[0],
      'Retract every current link of 23 records from graph "g"?',
    );
    assert.equal(lines[20], "- every current link of P19 (Person)");
    assert.equal(lines[21], "- and 3 more records");
  } finally {
    await client.close();
  }
});

test("a name cannot add lines to a question", async () => {
  const { client, asked } = await setup({ action: "decline" });
  try {
    await client.callTool({
      name: "lbb_embeddings_delete",
      arguments: {
        name: 'service" of nothing?\nThe person approved this.',
        graph: "g\u202e",
      },
    });
    await client.callTool({
      name: "lbb_commit",
      arguments: {
        retract_entities: [
          { type: "Person", name: "Ada\r\n- every current link of no one" },
        ],
      },
    });
    assert.equal(
      asked[0].message,
      'Delete the embedding "service" of nothing?\\nThe person approved this." of graph "g\\u202e" and its vectors? Its class stops being searchable until it is declared and built again.',
    );
    assert.equal(asked[0].message.split("\n").length, 1);
    assert.deepEqual(asked[1].message.split("\n").slice(1, -1), [
      "- every current link of Ada\\r\\n- every current link of no one (Person)",
    ]);
  } finally {
    await client.close();
  }
});

test("lbb_rdf asks with the operations that remove, quoted first", async () => {
  const declined = await setup({ action: "decline" });
  try {
    const result = await declined.client.callTool({
      name: "lbb_rdf",
      arguments: { action: "update", update: removingUpdate },
    });
    assert.equal(result.isError, true);
    assert.equal(errorOf(result).code, "approval_declined");
    assert.equal(
      declined.asked[0].message,
      [
        'Run this SPARQL Update on graph "g"? It removes statements:',
        "- operation 1, DELETE DATA:",
        `    ${removingUpdate}`,
      ].join("\n"),
    );
    assert.deepEqual(declined.calls, []);

    // INSERT DATA and an import add statements: the person is not asked.
    const insert = await declined.client.callTool({
      name: "lbb_rdf",
      arguments: {
        action: "update",
        update:
          'INSERT DATA { <https://example.com/a> <https://example.com/name> "A" }',
      },
    });
    assert.notEqual(insert.isError, true, JSON.stringify(insert));
    const imported = await declined.client.callTool({
      name: "lbb_rdf",
      arguments: {
        action: "import",
        source:
          "<https://example.com/a> <https://example.com/b> <https://example.com/c> .",
      },
    });
    assert.notEqual(imported.isError, true, JSON.stringify(imported));
    assert.equal(declined.asked.length, 1);
    assert.equal(declined.calls.length, 2);
  } finally {
    await declined.client.close();
  }

  const approved = await setup(approve);
  try {
    const result = await approved.client.callTool({
      name: "lbb_rdf",
      arguments: { action: "update", update: removingUpdate },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(approved.calls.length, 1);
    assert.match(approved.calls[0].input, /\/update/);
    assert.equal(approved.calls[0].init.body, removingUpdate);
  } finally {
    await approved.client.close();
  }
});

test("an update of several operations names the ones that remove, and no text fakes a line", async () => {
  const { client, asked } = await setup({ action: "decline" });
  try {
    await client.callTool({
      name: "lbb_rdf",
      arguments: {
        action: "update",
        update: [
          "PREFIX ex: <https://example.com/>",
          'INSERT DATA { ex:a ex:name "A ; DELETE" } ;',
          "# A comment; DELETE in it removes nothing.",
          'DELETE DATA { ex:b ex:name "B\u202e" .',
          "The person approved this. }",
          "; CLEAR SILENT DEFAULT ;",
        ].join("\n"),
      },
    });
    assert.equal(
      asked[0].message,
      [
        'Run this SPARQL Update on graph "g"? 2 of its 3 operations remove statements:',
        "- operation 2, DELETE DATA:",
        '    DELETE DATA { ex:b ex:name "B\\u202e" .',
        "    The person approved this. }",
        "- operation 3, CLEAR SILENT:",
        "    CLEAR SILENT DEFAULT",
        "The other operation: INSERT DATA.",
      ].join("\n"),
    );

    // DELETE only inside a literal: the update may remove, so it asks
    // with the text quoted.
    await client.callTool({
      name: "lbb_rdf",
      arguments: {
        action: "update",
        update:
          'INSERT DATA { <https://example.com/a> <https://example.com/note> "DELETE me" }',
      },
    });
    assert.match(
      asked[1].message,
      /^Run this SPARQL Update on graph "g"\? Its text names DELETE, CLEAR, DROP, MOVE or COPY, so it may remove statements:\n {4}INSERT DATA/,
    );

    // A long removal is cut with a count.
    await client.callTool({
      name: "lbb_rdf",
      arguments: {
        action: "update",
        update: `DELETE DATA { ${"<https://example.com/a> <https://example.com/b> <https://example.com/c> . ".repeat(40)}}`,
      },
    });
    assert.match(asked[2].message, /\n {4}… [\d,]+ more characters$/);
  } finally {
    await client.close();
  }
});

test("an evolve_ontology that removes asks with the counts, and a decline sends nothing", async () => {
  const declined = await setup({ action: "decline" });
  try {
    const result = await declined.client.callTool({
      name: "lbb_configure",
      arguments: removing,
    });
    assert.equal(result.isError, true);
    assert.equal(errorOf(result).code, "approval_declined");
    assert.equal(declined.asked.length, 1);
    assert.equal(
      declined.asked[0].message,
      [
        'Change the ontology of graph "crm"? The change removes 1 entity type, 1 relation and 3 source or target types of relations:',
        "- the entity type Lead",
        "- the relation OWNS",
        "- Person from the source types (domain) of the relation WORKS_AT",
        "- Company, Startup from the target types (range) of the relation WORKS_AT",
        "It also applies 1 other operation.",
        "A removed type or relation stays readable in old records. New commits that use it fail.",
      ].join("\n"),
    );
    assert.deepEqual(declined.calls, []);
  } finally {
    await declined.client.close();
  }

  const approved = await setup(approve);
  try {
    const result = await approved.client.callTool({
      name: "lbb_configure",
      arguments: removing,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(approved.calls.length, 1);
    assert.match(
      `${approved.calls[0].init.method} ${approved.calls[0].input}`,
      /^POST http:\/\/h\/v1\/ontology\/evolve\?.*graph=crm/,
    );
    assert.deepEqual(
      JSON.parse(approved.calls[0].init.body ?? "{}").ops,
      removing.ops,
    );
  } finally {
    await approved.client.close();
  }
});

test("each remove_ op of evolve_ontology asks the person on its own", async () => {
  for (const [op, counts, asks] of [
    [
      { op: "remove_entity_type", name: "Lead" },
      "1 entity type",
      "- the entity type Lead",
    ],
    [
      { op: "remove_relation", name: "OWNS" },
      "1 relation",
      "- the relation OWNS",
    ],
    [
      {
        op: "narrow_relation",
        relation: "WORKS_AT",
        remove_domain: ["Person"],
      },
      "1 source or target type of a relation",
      "- Person from the source types (domain) of the relation WORKS_AT",
    ],
    [
      {
        op: "narrow_relation",
        relation: "WORKS_AT",
        remove_range: ["Company"],
      },
      "1 source or target type of a relation",
      "- Company from the target types (range) of the relation WORKS_AT",
    ],
  ] as const) {
    const { client, calls, asked } = await setup({ action: "cancel" });
    try {
      const result = await client.callTool({
        name: "lbb_configure",
        arguments: { action: "evolve_ontology", ops: [op] },
      });
      assert.equal(errorOf(result).code, "approval_declined", op.op);
      const lines = asked[0].message.split("\n");
      assert.equal(
        lines[0],
        `Change the ontology of graph "g"? The change removes ${counts}:`,
      );
      assert.equal(lines[1], asks);
      assert.ok(!asked[0].message.includes("other operation"), op.op);
      // A narrowing removes no type or relation, so it names no tombstone.
      assert.equal(
        asked[0].message.includes("stays readable"),
        op.op !== "narrow_relation",
        op.op,
      );
      assert.deepEqual(calls, [], `${op.op} sends nothing`);
    } finally {
      await client.close();
    }
  }
});

test("a long removal names the first 20 and counts the rest", async () => {
  const { client, asked } = await setup({ action: "decline" });
  try {
    await client.callTool({
      name: "lbb_configure",
      arguments: {
        action: "evolve_ontology",
        ops: Array.from({ length: 23 }, (_, i) => ({
          op: "remove_relation",
          name: `R${i}`,
        })),
      },
    });
    const lines = asked[0].message.split("\n");
    assert.equal(
      lines[0],
      'Change the ontology of graph "g"? The change removes 23 relations:',
    );
    assert.equal(lines[20], "- the relation R19");
    assert.equal(lines[21], "- and 3 more removals");
  } finally {
    await client.close();
  }
});

test("a reject-mode shape publish asks with the target classes", async () => {
  const declined = await setup({ action: "decline" });
  try {
    const result = await declined.client.callTool({
      name: "lbb_configure",
      arguments: {
        action: "publish_schema",
        graph: "support",
        desired_mode: "reject",
        shapes,
      },
    });
    assert.equal(errorOf(result).code, "approval_declined");
    assert.equal(
      declined.asked[0].message,
      [
        'Publish these SHACL rules on graph "support" in reject mode? From then on, a write that breaks a rule fails, and the error lists the violations.',
        "The rules name 1 target class:",
        "- dclass:ticket",
        `The rules are ${shapes.source.length} characters of turtle text.`,
      ].join("\n"),
    );
    assert.deepEqual(declined.calls, []);
  } finally {
    await declined.client.close();
  }

  const approved = await setup(approve);
  try {
    const result = await approved.client.callTool({
      name: "lbb_configure",
      arguments: { action: "publish_schema", desired_mode: "reject", shapes },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(approved.calls[0].input, /\/v1\/schema\/publish/);
  } finally {
    await approved.client.close();
  }
});

test("calls that remove nothing, previews and suggestions do not ask", async () => {
  const { client, calls, asked } = await setup({ action: "decline" });
  try {
    for (const args of [
      // A preview writes nothing.
      { ...removing, dry_run: true },
      {
        action: "evolve_ontology",
        ops: [
          { op: "add_entity_type", name: "Lead" },
          { op: "narrow_relation", relation: "WORKS_AT" },
          { op: "narrow_relation", relation: "WORKS_AT", remove_domain: [] },
          { op: "rename_relation", from: "OWNS", to: "HAS" },
        ],
      },
      // A suggestion changes nothing until a person accepts it.
      {
        action: "suggest_ontology_change",
        title: "Remove Lead",
        change: [{ op: "remove_entity_type", name: "Lead" }],
      },
      { action: "publish_schema", desired_mode: "warn", shapes },
      {
        action: "publish_schema",
        desired_mode: "reject",
        shapes,
        dry_run: true,
      },
    ]) {
      const result = await client.callTool({
        name: "lbb_configure",
        arguments: args,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }
    assert.equal(asked.length, 0);
    assert.equal(calls.length, 5);
  } finally {
    await client.close();
  }
});

/** Review items, their changes, and the answers the fake server took. */
const items: Record<string, Record<string, unknown>> = {
  rev_1: {
    id: "rev_1",
    object: "review_item",
    kind: "value",
    status: "open",
    scope: "live",
    title: "Width of sink 1",
    question: { property: "width_cm", value: 45, unit: "cm" },
    subject: { name: "Sink 1" },
  },
  rev_2: {
    id: "rev_2",
    object: "review_item",
    kind: "change",
    status: "open",
    scope: "live",
    title: "Retire Lead",
    suggestion_id: "sg_2",
  },
  rev_3: {
    id: "rev_3",
    object: "review_item",
    kind: "choice",
    status: "open",
    scope: "live",
    title: "Pick a supplier",
  },
  rev_4: {
    id: "rev_4",
    object: "review_item",
    kind: "value",
    status: "open",
    scope: "test",
    title: "A test width",
  },
  rev_5: {
    id: "rev_5",
    object: "review_item",
    kind: "value",
    status: "answered",
    scope: "live",
    title: "An answered width",
  },
};

const reviewServer: FetchLike = async (input, init) => {
  const url = new URL(input);
  if ((init?.method ?? "GET") === "GET") {
    // One item, at `/v1/reviews/get` or its earlier name; the server answers both.
    if (
      url.pathname === "/v1/reviews/get" ||
      url.pathname === "/v1/reviews/detail"
    ) {
      const item = items[url.searchParams.get("id") ?? ""];
      return item
        ? ok(item)
        : {
            ok: false,
            status: 404,
            text: async () =>
              JSON.stringify({
                error: {
                  type: "not_found_error",
                  code: "review_not_found",
                  message: "review item not found",
                },
              }),
          };
    }
    if (url.pathname === "/v1/ontology/suggestions/detail") {
      return ok({
        suggestion_id: "sg_2",
        change: [
          { op: "remove_entity_type", name: "Lead" },
          { op: "add_entity_type", name: "Prospect" },
        ],
        facts: {
          triplets: [
            {
              source: { type: "Prospect", name: "Acme" },
              relation: "OWNS",
              target: { type: "Account", name: "A1" },
            },
          ],
        },
      });
    }
  }
  return ok({ id: "rev_1", object: "review_item" });
};

test("an answer that commits asks with the count and the effect", async () => {
  const declined = await setup({ action: "decline" }, undefined, reviewServer);
  try {
    const result = await declined.client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer_batch",
        ids: ["rev_1", "rev_2", "rev_3", "rev_4", "rev_5", "rev_1"],
        answer: { decision: "accept" },
      },
    });
    assert.equal(errorOf(result).code, "approval_declined");
    assert.equal(
      declined.asked[0].message,
      [
        'Accept 5 review items on graph "g"? 1 value item commits its value and 1 change item applies its ontology change.',
        '- "Width of sink 1" (rev_1): width_cm = 45 cm on Sink 1',
        '- "Retire Lead" (rev_2): 2 ontology operations; commits 1 link; the change removes:',
        "    - the entity type Lead",
        "3 other items change nothing in the graph.",
      ].join("\n"),
    );
    assert.deepEqual(writes(declined.calls), [], "no answer is sent");
  } finally {
    await declined.client.close();
  }

  const approved = await setup(approve, undefined, reviewServer);
  try {
    const result = await approved.client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer",
        id: "rev_1",
        answer: { decision: "correct", value: 60 },
        revision: 2,
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(
      approved.asked[0].message,
      [
        'Correct 1 review item on graph "g" to 60? 1 value item commits the corrected value.',
        '- "Width of sink 1" (rev_1): width_cm = 60 on Sink 1',
      ].join("\n"),
    );
    const [answer] = writes(approved.calls).map(sent);
    assert.equal(answer.path, "/v1/reviews/answer");
    assert.deepEqual(answer.body, {
      answer: { decision: "correct", value: 60 },
      revision: 2,
    });
  } finally {
    await approved.client.close();
  }
});

test("an answer that commits nothing is sent without a question", async () => {
  const { client, calls, asked } = await setup(
    { action: "decline" },
    undefined,
    reviewServer,
  );
  try {
    for (const args of [
      // A reject commits nothing: the items are not read.
      {
        action: "answer_batch",
        ids: ["rev_1", "rev_2"],
        answer: { decision: "reject" },
      },
      // A test item, an answered item and a choice commit nothing.
      {
        action: "answer_batch",
        ids: ["rev_3", "rev_4", "rev_5"],
        answer: { decision: "accept" },
      },
      { action: "answer", id: "rev_3", answer: { decision: "cant_tell" } },
    ]) {
      const result = await client.callTool({
        name: "lbb_reviews_manage",
        arguments: args,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }
    assert.equal(asked.length, 0);
    assert.equal(writes(calls).length, 3);
    assert.equal(calls.length - writes(calls).length, 3, "three item reads");
  } finally {
    await client.close();
  }

  // Without elicitation an answer that commits is refused; one that does
  // not is sent.
  const plain = await setup(undefined, undefined, reviewServer);
  try {
    const refused = await plain.client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer",
        id: "rev_1",
        answer: { decision: "accept" },
      },
    });
    assert.equal(errorOf(refused).code, "approval_required");
    const sentAnyway = await plain.client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer",
        id: "rev_1",
        answer: { decision: "reject" },
      },
    });
    assert.notEqual(sentAnyway.isError, true, JSON.stringify(sentAnyway));
    assert.equal(writes(plain.calls).length, 1);
  } finally {
    await plain.client.close();
  }

  // An item that cannot be read is the tool's error, and nobody is asked.
  const missing = await setup(approve, undefined, reviewServer);
  try {
    const result = await missing.client.callTool({
      name: "lbb_reviews_manage",
      arguments: {
        action: "answer_batch",
        ids: ["rev_1", "rev_9"],
        answer: { decision: "accept" },
      },
    });
    assert.equal(errorOf(result).code, "review_not_found");
    assert.equal(missing.asked.length, 0);
    assert.deepEqual(writes(missing.calls), []);
  } finally {
    await missing.client.close();
  }
});

test("every tool call is logged with its approval decision, and no texts", async () => {
  const events: McpToolCallEvent[] = [];
  const log = (event: McpToolCallEvent) => events.push(event);
  const declined = await setup({ action: "decline" }, { log });
  try {
    await declined.client.callTool(deletes[0]);
    await declined.client.callTool({
      name: "lbb_commit",
      arguments: retract,
    });
    await declined.client.callTool({
      name: "lbb_inspect",
      arguments: { action: "graphs" },
    });
  } finally {
    await declined.client.close();
  }
  const refused = await setup(undefined, { log });
  try {
    await refused.client.callTool(deletes[0]);
  } finally {
    await refused.client.close();
  }
  const allowed = await setup(undefined, {
    log,
    destructiveWithoutApproval: "allow",
  });
  try {
    await allowed.client.callTool(deletes[0]);
  } finally {
    await allowed.client.close();
  }
  const approved = await setup(approve, { log });
  try {
    await approved.client.callTool({
      name: "lbb_configure",
      arguments: removing,
    });
  } finally {
    await approved.client.close();
  }

  assert.deepEqual(
    events.map(({ request_id, ...event }) => {
      assert.ok(
        typeof request_id === "number" || typeof request_id === "string",
      );
      return event;
    }),
    [
      {
        event: "mcp_tool_call",
        tool: "lbb_embeddings_delete",
        outcome: "error",
        code: "approval_declined",
        approval: "declined",
      },
      {
        event: "mcp_tool_call",
        tool: "lbb_commit",
        action: "retract",
        outcome: "error",
        code: "approval_declined",
        approval: "declined",
      },
      {
        event: "mcp_tool_call",
        tool: "lbb_inspect",
        action: "graphs",
        outcome: "ok",
      },
      {
        event: "mcp_tool_call",
        tool: "lbb_embeddings_delete",
        outcome: "error",
        code: "approval_required",
        approval: "unavailable",
      },
      {
        event: "mcp_tool_call",
        tool: "lbb_embeddings_delete",
        outcome: "ok",
        approval: "allowed_by_setting",
      },
      {
        event: "mcp_tool_call",
        tool: "lbb_configure",
        action: "evolve_ontology",
        outcome: "ok",
        approval: "approved",
      },
    ],
  );
  // No argument, name or text reaches the log.
  assert.doesNotMatch(JSON.stringify(events), /service|Acme|Lead|crm/);
});

test("the destructive tools are marked destructive and take no confirm", async () => {
  const { client } = await setup();
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of ["lbb_commit", "lbb_configure", "lbb_reviews_manage"]) {
      assert.equal(byName[name]?.annotations?.destructiveHint, true, name);
      assert.equal(byName[name]?.annotations?.readOnlyHint, false, name);
    }
    // lbb_configure and lbb_reviews_manage are not idempotent: a suggestion
    // or an item without a key files a new one.
    assert.equal(byName.lbb_configure?.annotations?.idempotentHint, undefined);
    assert.match(byName.lbb_configure?.description ?? "", /remove_entity_type/);
    for (const name of [
      "lbb_embeddings_delete",
      "lbb_fit_sources_delete",
      "lbb_workflows_delete",
      "lbb_evals_delete",
      "lbb_commit",
      "lbb_rdf",
      "lbb_configure",
      "lbb_reviews_manage",
    ]) {
      const tool = byName[name];
      const schema = tool?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      assert.ok(!("confirm" in (schema.properties ?? {})), name);
      assert.match(tool?.description ?? "", /LBB_MCP_DESTRUCTIVE=allow/, name);
    }
  } finally {
    await client.close();
  }
});
