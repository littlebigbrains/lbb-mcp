import { test } from "node:test";
import assert from "node:assert/strict";
import { updateOperations } from "./sparql-update.js";

test("an update splits into its operations, each with its form", () => {
  const update = [
    "PREFIX ex: <https://example.com/>",
    "BASE <https://example.com/base/>",
    'INSERT DATA { ex:a ex:name "x ; y" } ;',
    "DELETE DATA { ex:a ex:name 'z' } ;",
    "DELETE WHERE { ?s ex:old ?o } ;",
    "DELETE { ?s ex:p ?o } INSERT { ?s ex:q ?o } WHERE { ?s ex:p ?o } ;",
    "DELETE { ?s ex:p ?o } WHERE { ?s ex:p ?o } ;",
    "WITH <https://example.com/g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o } ;",
    'INSERT { ?s ex:seen "DELETE" } WHERE { ?s ?p ?o FILTER(?o < 5) } ;',
    "# CLEAR ALL in a comment",
    "LOAD <https://example.com/data.ttl> ;",
    "CLEAR SILENT GRAPH <https://example.com/g> ;",
    "DROP ALL ; MOVE DEFAULT TO <https://example.com/g> ;",
    "COPY DEFAULT TO <https://example.com/h> ; ADD DEFAULT TO <https://example.com/i> ;",
    "CREATE GRAPH <https://example.com/j> ;",
  ].join("\n");
  assert.deepEqual(
    updateOperations(update).map(({ form, removes }) => [form, removes]),
    [
      ["INSERT DATA", false],
      ["DELETE DATA", true],
      ["DELETE WHERE", true],
      ["DELETE/INSERT", true],
      ["DELETE", true],
      ["WITH DELETE", true],
      ["INSERT", false],
      ["LOAD", false],
      ["CLEAR SILENT", true],
      ["DROP", true],
      ["MOVE", true],
      ["COPY", true],
      ["ADD", false],
      ["CREATE", false],
    ],
  );
  // Each text starts at its keyword: the prologue and comments stay out.
  const [first, second] = updateOperations(update);
  assert.equal(first.text, 'INSERT DATA { ex:a ex:name "x ; y" }');
  assert.equal(second.text, "DELETE DATA { ex:a ex:name 'z' }");
});

test("strings, IRIs and long strings do not end an operation", () => {
  const operations = updateOperations(
    [
      'INSERT DATA { <https://example.com/a;b> <https://example.com/n> """one ;',
      'two } ; DELETE""" }',
    ].join("\n"),
  );
  assert.equal(operations.length, 1);
  assert.equal(operations[0].form, "INSERT DATA");
  assert.equal(operations[0].removes, false);
});
