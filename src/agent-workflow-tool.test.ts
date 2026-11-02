import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, ok, sent, type Call } from "./test-support.js";

test("Agent Run again preserves original inputs and graph without rescanning", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ queued: true });
  });
  try {
    const inputs = [
      { iri: "urn:document:source" },
      { sha256: "ab".repeat(32) },
    ];
    const answer = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "run",
        name: "catalogue",
        graph: "qualification",
        inputs,
      },
    });
    assert.notEqual(answer.isError, true, JSON.stringify(answer));
    assert.deepEqual(sent(calls.at(-1)!), {
      method: "POST",
      path: "/v1/workflows/named/run",
      query: { graph: "qualification", name: "catalogue" },
      body: { inputs },
      key: undefined,
    });
    const plain = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: { action: "run", name: "catalogue" },
    });
    assert.notEqual(plain.isError, true);
    assert.equal(sent(calls.at(-1)!).body, undefined);
  } finally {
    await client.close();
  }
});

test("Agent Run again refuses ambiguous or unbounded inputs before I/O", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ queued: true });
  });
  try {
    for (const inputs of [
      [],
      Array.from({ length: 17 }, () => ({ iri: "urn:x" })),
      [{ iri: "urn:x", sha256: "ab".repeat(32) }],
      [{ sha256: "AB".repeat(32) }],
      [{ iri: "" }],
    ]) {
      const answer = await client.callTool({
        name: "lbb_workflows_manage",
        arguments: { action: "run", name: "catalogue", inputs },
      });
      assert.equal(answer.isError, true, JSON.stringify(inputs));
    }
    const wrongAction = await client.callTool({
      name: "lbb_workflows_manage",
      arguments: {
        action: "pause",
        name: "catalogue",
        inputs: [{ iri: "urn:x" }],
      },
    });
    assert.equal(wrongAction.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
  }
});

test("Agent Run again takes the iri the server takes and refuses the rest before I/O", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok({ queued: true });
  });
  const host = "https://example.org/";
  try {
    // The server refuses more than 2048 bytes, any scheme but http, https and
    // urn (in lower case), whitespace and the characters < > " { } | \ ^ and `.
    for (const iri of [
      "ftp://example.org/x",
      "mailto:a@example.org",
      "HTTP://example.org/x",
      "example.org/x",
      "/relative/path",
      host + "a".repeat(2029),
      host + "é".repeat(1015),
      "https://example.org/a b",
      "urn:x\n",
      'https://example.org/"x',
      "https://example.org/{x}",
      "https://example.org/a|b",
      "https://example.org/a^b",
      "https://example.org/a\\b",
      "https://example.org/a`b",
      "https://example.org/<x>",
    ]) {
      const answer = await client.callTool({
        name: "lbb_workflows_manage",
        arguments: { action: "run", name: "catalogue", inputs: [{ iri }] },
      });
      assert.equal(answer.isError, true, JSON.stringify(iri.slice(0, 60)));
    }
    assert.equal(calls.length, 0);
    for (const iri of [
      "http://example.org/x",
      "https://example.org/x?y=1#z",
      "urn:uuid:6f1c0c1e-0000-4000-8000-000000000000",
      host + "a".repeat(2028),
      host + "é".repeat(1014),
    ]) {
      const answer = await client.callTool({
        name: "lbb_workflows_manage",
        arguments: { action: "run", name: "catalogue", inputs: [{ iri }] },
      });
      assert.notEqual(answer.isError, true, JSON.stringify(iri.slice(0, 60)));
      assert.deepEqual(sent(calls.at(-1)!).body, { inputs: [{ iri }] });
    }
    assert.equal(calls.length, 5);
  } finally {
    await client.close();
  }
});
