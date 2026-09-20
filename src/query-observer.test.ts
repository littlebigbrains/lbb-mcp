import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, ok, payload } from "./test-support.js";
import type { McpQueryStageEvent } from "./index.js";

test("compact query text fits and renders the same whole Unicode rows with safe local timing", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    subject: { type: "uri", value: `urn:PRIVATE_SENTINEL:person:${i}` },
    value: { type: "literal", value: `${i}:🧠漢字 café\ncomplete value` },
  }));
  const pages: number[] = [];
  for (const queryTextFormat of ["pretty", "compact"] as const) {
    let clock = 0;
    let metadataCalls = 0;
    let queryCalls = 0;
    const events: McpQueryStageEvent[] = [];
    const client = await connect(
      async (input, init) => {
        if (input.includes("metadata")) {
          metadataCalls++;
          clock += 10;
          return {
            ok: true,
            status: 200,
            text: async () => {
              clock += 4;
              return JSON.stringify({ snapshot: { commit_seq: 934 } });
            },
          };
        }
        queryCalls++;
        clock += 20;
        const request = JSON.parse(init?.body ?? "{}");
        assert.equal(request.as_of_commit_seq, 934);
        assert.equal(request.limit, 1000);
        const bindings = rows.slice(
          request.offset,
          request.offset + request.limit,
        );
        return {
          ok: true,
          status: 200,
          text: async () => {
            clock += 6;
            return JSON.stringify({
              results: JSON.stringify({
                head: { vars: ["subject", "value"] },
                results: { bindings },
              }),
              row_page: {
                offset: request.offset,
                limit: request.limit,
                returned: bindings.length,
                total: rows.length,
                has_more: false,
              },
            });
          },
        };
      },
      {
        queryTextFormat,
        timing: { now: () => clock, observe: (event) => events.push(event) },
      },
    );
    try {
      let args: Record<string, unknown> = {
        mode: "sparql",
        query:
          "SELECT ?subject ?value WHERE {?subject <urn:PRIVATE_SENTINEL> ?value}",
        detail: "full",
        row_limit: 1000,
      };
      const seen: unknown[] = [];
      for (let page = 0; page < 20; page++) {
        const result = await client.callTool({
          name: "lbb_query",
          arguments: args,
        });
        assert.notEqual(result.isError, true);
        const text = (result.content as { text: string }[])[0].text;
        assert.ok(Buffer.byteLength(text, "utf8") <= 80_000);
        assert.deepEqual(
          JSON.parse(text),
          JSON.parse(JSON.stringify(result.structuredContent)),
        );
        assert.equal(
          text,
          JSON.stringify(
            result.structuredContent,
            null,
            queryTextFormat === "pretty" ? 2 : undefined,
          ),
        );
        const pageBody = payload(result);
        const bindings = (pageBody.data as { results: { bindings: unknown[] } })
          .results.bindings;
        assert.equal(pageBody.row_page?.offset, seen.length);
        assert.equal(pageBody.row_page?.returned, bindings.length);
        seen.push(...bindings);
        const rendered = events.at(-1);
        assert.equal(rendered?.stage, "query_render");
        assert.equal(rendered.text_bytes, Buffer.byteLength(text, "utf8"));
        assert.equal(rendered.returned_rows, bindings.length);
        assert.equal(rendered.continuation, page !== 0);
        assert.equal(
          rendered.cursor_bytes,
          pageBody.next ? Buffer.byteLength(pageBody.next.cursor as string) : 0,
        );
        if (!pageBody.next) break;
        args = pageBody.next;
      }
      assert.deepEqual(seen, rows);
      assert.equal(metadataCalls, 1);
      assert.equal(
        events.filter((event) => event.stage === "query_pin_metadata").length,
        1,
      );
      assert.equal(
        events.find((event) => event.stage === "query_pin_metadata")
          ?.durationMs,
        14,
      );
      assert.ok(
        events
          .filter((event) => event.stage === "query_http_total")
          .every((event) => event.durationMs === 26),
      );
      assert.equal(
        events.filter((event) => event.stage === "query_render").length,
        queryCalls,
      );
      assert.ok(events.every((event) => event.outcome === "success"));
      assert.doesNotMatch(
        JSON.stringify(events),
        /PRIVATE_SENTINEL|urn:|SELECT|complete value/,
      );
      pages.push(queryCalls);
    } finally {
      await client.close();
    }
  }
  assert.ok(pages[1] < pages[0], `compact=${pages[1]}, pretty=${pages[0]}`);
});

test("observer and clock failures cannot change ASK or structured query answers", async () => {
  for (const mode of ["sparql", "structured"] as const) {
    const client = await connect(
      async () =>
        mode === "sparql"
          ? ok({ results: JSON.stringify({ head: {}, boolean: true }) })
          : ok({
              solutions: [{ value: "whole 🧠 value" }],
              row_page: {
                returned: 1,
                total: 1,
                offset: 0,
                limit: 20,
                has_more: false,
              },
            }),
      {
        timing: {
          now: () => {
            throw new Error("PRIVATE_CLOCK_ERROR");
          },
          observe: () => {
            throw new Error("PRIVATE_OBSERVER_ERROR");
          },
        },
      },
    );
    try {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: {
          mode,
          as_of_commit_seq: 934,
          ...(mode === "sparql" ? { query: "ASK {?s ?p ?o}" } : { body: {} }),
        },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(
        payload(result),
        JSON.parse(JSON.stringify(result.structuredContent)),
      );
      assert.equal(
        (payload(result).data as { boolean?: boolean }).boolean,
        mode === "sparql" ? true : undefined,
      );
    } finally {
      await client.close();
    }
  }
});

test("oversized single rows remain actionable and retries do not advance the pin or offset", async () => {
  const events: McpQueryStageEvent[] = [];
  const requests: { offset: number; as_of_commit_seq: number }[] = [];
  const client = await connect(
    async (_input, init) => {
      requests.push(JSON.parse(init?.body ?? "{}"));
      return ok({
        results: JSON.stringify({
          head: { vars: ["value"] },
          results: {
            bindings: [
              {
                value: {
                  type: "literal",
                  value: "PRIVATE_BODY_🧠".repeat(10000),
                },
              },
            ],
          },
        }),
        row_page: {
          offset: 0,
          limit: 20,
          returned: 1,
          total: 1,
          has_more: false,
        },
      });
    },
    { timing: { observe: (event) => events.push(event) } },
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.callTool({
        name: "lbb_query",
        arguments: {
          mode: "sparql",
          query: "SELECT ?value WHERE {?s ?p ?value}",
          as_of_commit_seq: 934,
        },
      });
      assert.equal(result.isError, true);
      const body = result.structuredContent as {
        error: { message: string };
        next?: unknown;
      };
      assert.match(
        body.error.message,
        /One query row.*SPARQL HTTP API.*no rows were skipped/,
      );
      assert.equal(body.next, undefined);
    }
    assert.deepEqual(
      requests.map(({ offset, as_of_commit_seq }) => ({
        offset,
        as_of_commit_seq,
      })),
      [
        { offset: 0, as_of_commit_seq: 934 },
        { offset: 0, as_of_commit_seq: 934 },
      ],
    );
    assert.equal(
      events.filter(
        (event) =>
          event.stage === "query_envelope" && event.outcome === "error",
      ).length,
      2,
    );
    assert.equal(
      events.filter((event) => event.stage === "query_pin_metadata").length,
      0,
    );
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_BODY|SELECT|urn:/);
  } finally {
    await client.close();
  }
});

test("results parse failures emit a redacted failure stage without changing the error", async () => {
  const events: McpQueryStageEvent[] = [];
  const client = await connect(
    async () => ok({ results: "PRIVATE_INVALID_JSON" }),
    { timing: { observe: (event) => events.push(event) } },
  );
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: {
        mode: "sparql",
        query: "ASK {?s ?p ?o}",
        as_of_commit_seq: 934,
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(
      events.map(({ stage, outcome }) => ({ stage, outcome })),
      [
        { stage: "query_http_total", outcome: "success" },
        { stage: "query_results_parse", outcome: "error" },
      ],
    );
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_INVALID|ASK/);
  } finally {
    await client.close();
  }
});

test("normalization notes participate in the final byte fit", async () => {
  const notesQuery = `SELECT ?value WHERE { ${Array.from({ length: 180 }, (_, i) => `?s <https://littlebigbrain.com/r/UPPER_${i}> ?value .`).join(" ")} }`;
  const rows = Array.from({ length: 10 }, (_, i) => ({
    value: { type: "literal", value: `${i}:` + "漢字".repeat(400) },
  }));
  const client = await connect(async (_input, init) => {
    const request = JSON.parse(init?.body ?? "{}");
    const bindings = rows.slice(request.offset);
    return ok({
      results: JSON.stringify({
        head: { vars: ["value"] },
        results: { bindings },
      }),
      row_page: {
        offset: request.offset,
        limit: 20,
        returned: bindings.length,
        total: rows.length,
        has_more: false,
      },
    });
  });
  try {
    const result = await client.callTool({
      name: "lbb_query",
      arguments: { mode: "sparql", query: notesQuery, as_of_commit_seq: 934 },
    });
    assert.notEqual(result.isError, true);
    const text = (result.content as { text: string }[])[0].text;
    assert.ok(Buffer.byteLength(text) <= 80_000);
    assert.deepEqual(
      JSON.parse(text),
      JSON.parse(JSON.stringify(result.structuredContent)),
    );
    assert.equal(
      (result.structuredContent as { notes: string[] }).notes.length,
      180,
    );
  } finally {
    await client.close();
  }
});

test("empty SELECT and ASK keep their shapes; oversized notes fail without an over-cap result", async () => {
  for (const ask of [false, true]) {
    const events: McpQueryStageEvent[] = [];
    const client = await connect(
      async () =>
        ok({
          results: JSON.stringify(
            ask
              ? { head: {}, boolean: false }
              : { head: { vars: ["value"] }, results: { bindings: [] } },
          ),
          ...(ask
            ? {}
            : {
                row_page: {
                  offset: 0,
                  limit: 20,
                  returned: 0,
                  total: 0,
                  has_more: false,
                },
              }),
        }),
      { timing: { observe: (event) => events.push(event) } },
    );
    try {
      const query = ask
        ? "ASK {?s ?p ?o}"
        : "SELECT ?value WHERE {?s ?p ?value}";
      const small = await client.callTool({
        name: "lbb_query",
        arguments: { mode: "sparql", query, as_of_commit_seq: 934 },
      });
      assert.notEqual(small.isError, true);
      assert.equal(payload(small).next, undefined);
      if (ask)
        assert.equal(
          (payload(small).data as { boolean: boolean }).boolean,
          false,
        );
      else assert.equal(payload(small).row_page?.returned, 0);
      const hugeQuery = `${ask ? "ASK" : "SELECT ?value"} WHERE { ${Array.from({ length: 500 }, (_, i) => `?s <https://littlebigbrain.com/r/UPPER_${i}> ?value .`).join(" ")} }`;
      const oversized = await client.callTool({
        name: "lbb_query",
        arguments: { mode: "sparql", query: hugeQuery, as_of_commit_seq: 934 },
      });
      assert.equal(oversized.isError, true);
      const text = (oversized.content as { text: string }[])[0].text;
      assert.ok(Buffer.byteLength(text) <= 80_000);
      assert.match(
        text,
        /MCP output budget.*SPARQL HTTP API.*no rows were skipped/,
      );
      assert.equal(events.at(-1)?.outcome, "error");
      assert.equal(
        events.at(-1)?.stage,
        ask ? "query_render" : "query_envelope",
      );
    } finally {
      await client.close();
    }
  }
});
