import assert from "node:assert/strict";
import { test } from "node:test";
import { unconfiguredClient } from "./stdio.js";

test("unconfigured client throws the Connect-page help on any method access", () => {
  const client = unconfiguredClient() as unknown as Record<string, unknown>;
  assert.throws(
    () => client.graphSearch,
    /LBB_BASE_URL is required.*Connect page/,
  );
});

test("unconfigured client tolerates duck-typing probes", () => {
  const client = unconfiguredClient() as unknown as Record<
    string | symbol,
    unknown
  >;
  assert.equal(client.then, undefined);
  assert.equal(client[Symbol.toStringTag], undefined);
});
