import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LbbClient } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";
import { SANDBOX_NOT_ENABLED_TEXT } from "./sandboxes-tool.js";

// Opt in with a local server that runs the Docker sandbox backend:
//
//   npm run dev:stack -- --sandbox docker --no-console --port 7462
//   LBB_TEST_SANDBOX_URL=http://127.0.0.1:7462 LBB_TEST_SANDBOX_KEY=lbb_sk_test_local npm test -w @littlebigbrain/mcp
//
// The test creates real containers and removes them. It refuses any URL that
// is not on this machine: it never reaches a hosted service. With
// LBB_TEST_NO_SANDBOX_URL it also reads a local server that has no backend.
const baseUrl = process.env.LBB_TEST_SANDBOX_URL;
const apiKey = process.env.LBB_TEST_SANDBOX_KEY;
const graph = process.env.LBB_TEST_SANDBOX_GRAPH ?? "main";
const offUrl = process.env.LBB_TEST_NO_SANDBOX_URL;

function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(host),
    `the sandbox live test runs only against this machine, not ${host}`,
  );
}

type Tool = Awaited<ReturnType<Client["callTool"]>>;

async function connected(url: string, approve: boolean | undefined) {
  assertLoopback(url);
  const server = buildLbbServer(
    new LbbClient({ baseUrl: url, apiKey, graph, retryDelayMs: 20 }),
    { log: () => {}, destructiveWithoutApproval: "refuse", sandboxes: true },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "sandboxes-live-test", version: "1" },
    approve === undefined ? undefined : { capabilities: { elicitation: {} } },
  );
  if (approve !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, (): ElicitResult => ({
      action: "accept",
      content: { confirm: approve },
    }));
  }
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function body(result: Tool): {
  summary: string;
  data: Record<string, any>;
  idempotency_key?: string;
  next?: Record<string, unknown>;
  truncated?: boolean;
} {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse((result.content as { text: string }[])[0].text);
}

function failure(result: Tool): { code: string; message: string } {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  return (
    result.structuredContent as { error: { code: string; message: string } }
  ).error;
}

test(
  "the sandbox tools run code, keep a workspace and destroy it, against local containers",
  { skip: !baseUrl, timeout: 240_000 },
  async () => {
    const url = baseUrl as string;
    const client = await connected(url, undefined);
    const approving = await connected(url, true);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { graph, ...args } });
    const manage = (args: Record<string, unknown>) =>
      call("lbb_sandboxes_manage", args);
    const read = (args: Record<string, unknown>) => call("lbb_sandboxes", args);
    let held: string | undefined;
    try {
      // One call, level 1.
      const sum = body(
        await manage({
          action: "run",
          code: "def run(input, config):\n    return sum(input)",
          input: [1, 2, 3],
        }),
      );
      assert.equal(sum.data.ok, true, sum.summary);
      assert.equal(sum.data.result, 6);
      assert.equal(sum.data.sandbox.status, "destroyed");

      // Code that raises is an answer with ok false and the end of its output.
      const raised = body(
        await manage({
          action: "run",
          code: "def run(input, config):\n    return 1 / 0",
        }),
      );
      assert.equal(raised.data.ok, false);
      assert.match(raised.data.command_record.stderr.tail, /ZeroDivisionError/);

      // The same key sent twice finds the same sandbox and the same command:
      // the code ran once.
      const key = `mcp-live-${Date.now()}`;
      const first = body(
        await manage({
          action: "run",
          code: "def run(input, config):\n    return sum(input)",
          input: [4, 5],
          idempotency_key: key,
        }),
      );
      const repeated = body(
        await manage({
          action: "run",
          code: "def run(input, config):\n    return sum(input)",
          input: [4, 5],
          idempotency_key: key,
        }),
      );
      assert.equal(first.idempotency_key, key);
      assert.equal(repeated.idempotency_key, key);
      assert.equal(first.data.result, 9);
      assert.equal(repeated.data.command, first.data.command);
      assert.equal(repeated.data.sandbox.id, first.data.sandbox.id);
      // Another request under the same key is a conflict, and it names the key.
      const conflict = failure(
        await manage({
          action: "run",
          code: "def run(input, config):\n    return 0",
          idempotency_key: key,
        }),
      );
      assert.equal(conflict.code, "idempotency_conflict");

      // Node, and the shell, are base templates too.
      const node = body(
        await manage({
          action: "run",
          template: "lbb/node",
          code: "function run(input) { return input.map((x) => x * 2); }",
          input: [1, 2],
        }),
      );
      assert.deepEqual(node.data.result, [2, 4]);

      // A saved template, level 2.
      const saved = body(
        await manage({
          action: "templates_create",
          name: "mcp-live-sum",
          code: "def run(input, config):\n    return sum(input) + config['plus']",
          config: { plus: 10 },
        }),
      );
      assert.match(saved.summary, /^saved template sbt_/);
      const viaTemplate = body(
        await manage({
          action: "run",
          template: "mcp-live-sum",
          input: [1, 2, 3],
        }),
      );
      assert.equal(viaTemplate.data.result, 16);
      const templates = body(
        await read({ action: "templates_list", detail: "full" }),
      );
      assert.ok(
        templates.data.data.some(
          (entry: { name: string }) => entry.name === "mcp-live-sum",
        ),
      );
      const templateId = saved.data.id as string;
      const shown = body(
        await read({ action: "templates_retrieve", template: templateId }),
      );
      assert.match(shown.data.code, /def run/);

      // A sandbox you keep, level 3.
      const created = body(
        await manage({
          action: "create",
          template: "mcp-live-sum",
          expires_in_seconds: 600,
          metadata: { purpose: "mcp-live-test" },
        }),
      );
      held = created.data.id as string;
      for (let tries = 0; tries < 40; tries += 1) {
        const state = body(await read({ action: "retrieve", sandbox: held }));
        if (state.data.status === "running") break;
        await delay(500);
      }
      const listed = body(
        await read({ action: "list", kind: "sandbox", detail: "full" }),
      );
      assert.ok(
        listed.data.data.some((entry: { id: string }) => entry.id === held),
      );

      const csv = "name,qty\nbolt,3\nnut,4\n";
      body(
        await manage({
          action: "files_write",
          sandbox: held,
          path: "data.csv",
          text: csv,
        }),
      );
      body(
        await manage({
          action: "files_write",
          sandbox: held,
          path: "blob.bin",
          base64: Buffer.from([0, 255, 1, 254]).toString("base64"),
        }),
      );
      const dir = body(
        await read({ action: "files_list", sandbox: held, detail: "full" }),
      );
      assert.deepEqual(
        dir.data.data.map((entry: { path: string }) => entry.path).sort(),
        ["/workspace/blob.bin", "/workspace/data.csv"],
      );
      const text = body(
        await read({ action: "files_read", sandbox: held, path: "data.csv" }),
      );
      assert.equal(text.data.text, csv);
      const blob = body(
        await read({ action: "files_read", sandbox: held, path: "blob.bin" }),
      );
      assert.equal(blob.data.encoding, "base64");
      assert.equal(
        blob.data.data,
        Buffer.from([0, 255, 1, 254]).toString("base64"),
      );
      const part = body(
        await read({
          action: "files_read",
          sandbox: held,
          path: "data.csv",
          max_bytes: 4,
        }),
      );
      assert.equal(part.data.text, "name");
      assert.equal(part.next?.offset, 4);

      // A command with argv, a run on the sandbox, and their records.
      const wc = body(
        await manage({
          action: "commands_create",
          sandbox: held,
          argv: ["bash", "-lc", "wc -l < data.csv; echo oops >&2"],
          cwd: "/workspace",
        }),
      );
      assert.equal(wc.data.status, "exited");
      assert.equal(wc.data.stdout.tail.trim(), "3");
      assert.equal(wc.data.stderr.tail.trim(), "oops");
      assert.equal(wc.data.env_names.length, 0);
      // env values and stdin are never stored: a command that prints neither
      // leaves a record with the names and the size only.
      const secretValue = "s3cret-value";
      const secretStdin = "from-stdin-text";
      const secret = body(
        await manage({
          action: "commands_create",
          sandbox: held,
          argv: ["true"],
          env: { TOKEN: secretValue },
          stdin: secretStdin,
        }),
      );
      assert.deepEqual(secret.data.env_names, ["TOKEN"]);
      assert.equal(secret.data.stdin_bytes, secretStdin.length);
      const stored = body(
        await read({
          action: "commands_retrieve",
          sandbox: held,
          command: secret.data.id,
          detail: "full",
        }),
      );
      for (const record of [secret, stored]) {
        const text = JSON.stringify(record);
        assert.ok(!text.includes(secretValue), "the record holds an env value");
        assert.ok(
          !text.includes(secretStdin),
          "the record holds the stdin text",
        );
      }
      const echoed = body(
        await manage({
          action: "commands_create",
          sandbox: held,
          argv: ["bash", "-lc", "echo $TOKEN; cat"],
          env: { TOKEN: secretValue },
          stdin: secretStdin,
        }),
      );
      // Only the output the command printed holds them.
      assert.match(echoed.data.stdout.tail, new RegExp(secretValue));
      assert.match(echoed.data.stdout.tail, new RegExp(secretStdin));
      const ran = body(
        await manage({
          action: "commands_create",
          sandbox: held,
          code: "def run(input, config):\n    return open('data.csv').read().count('\\n')",
          input: null,
        }),
      );
      assert.equal(ran.data.result, 3);
      const commands = body(
        await read({
          action: "commands_list",
          sandbox: held,
          status: "exited",
          detail: "full",
        }),
      );
      assert.ok(commands.data.data.length >= 3);
      const retrieved = body(
        await read({
          action: "commands_retrieve",
          sandbox: held,
          command: wc.data.id,
        }),
      );
      assert.equal(retrieved.data.id, wc.data.id);
      const logs = body(
        await read({
          action: "commands_logs",
          sandbox: held,
          command: wc.data.id,
          stream: "stderr",
        }),
      );
      assert.equal(logs.data.text.trim(), "oops");
      assert.equal(logs.data.done, true);

      // A command sent twice under one key runs once: the file has one line.
      const once = `mcp-live-cmd-${Date.now()}`;
      const append = {
        action: "commands_create",
        sandbox: held,
        argv: ["bash", "-lc", "echo x >> counter.txt"],
        idempotency_key: once,
      };
      const sentOnce = body(await manage(append));
      const sentTwice = body(await manage(append));
      assert.equal(sentTwice.data.id, sentOnce.data.id);
      const counter = body(
        await read({
          action: "files_read",
          sandbox: held,
          path: "counter.txt",
        }),
      );
      assert.equal(counter.data.text, "x\n");

      // A command that is still running, then its cancel.
      const slow = body(
        await manage({
          action: "commands_create",
          sandbox: held,
          argv: ["sleep", "120"],
          wait_ms: 0,
        }),
      );
      assert.match(slow.summary, /has not ended/);
      const cancelled = body(
        await manage({
          action: "commands_cancel",
          sandbox: held,
          command: slow.data.id,
          grace_ms: 500,
        }),
      );
      assert.equal(cancelled.data.status, "cancelled");

      // Update, stop, and a stopped sandbox refuses a file read and answers in its own words.
      const updated = body(
        await manage({
          action: "update",
          sandbox: held,
          auto_stop_seconds: 120,
          metadata: { purpose: "mcp-live-test", step: "updated" },
        }),
      );
      assert.equal(updated.data.auto_stop_seconds, 120);
      const stopped = body(await manage({ action: "stop", sandbox: held }));
      assert.match(stopped.data.status, /^(stopping|stopped)$/);
      for (let tries = 0; tries < 40; tries += 1) {
        const state = body(await read({ action: "retrieve", sandbox: held }));
        if (state.data.status === "stopped") break;
        await delay(500);
      }
      const refused = failure(
        await read({ action: "files_list", sandbox: held }),
      );
      assert.equal(refused.code, "sandbox_not_running");
      const resumed = body(await manage({ action: "resume", sandbox: held }));
      assert.match(resumed.data.status, /^(starting|running)$/);
      for (let tries = 0; tries < 40; tries += 1) {
        const state = body(await read({ action: "retrieve", sandbox: held }));
        if (state.data.status === "running") break;
        await delay(500);
      }
      // The disk stayed through the stop.
      const again = body(
        await read({ action: "files_read", sandbox: held, path: "data.csv" }),
      );
      assert.equal(again.data.text, csv);
      body(
        await manage({
          action: "files_delete",
          sandbox: held,
          path: "blob.bin",
        }),
      );
      const afterDelete = failure(
        await read({ action: "files_read", sandbox: held, path: "blob.bin" }),
      );
      assert.equal(afterDelete.code, "sandbox_file_not_found");

      // An argument that does not belong to the action is refused, and nothing is made.
      const before = body(
        await read({ action: "list", kind: "run", detail: "full" }),
      );
      const stray = failure(
        await manage({
          action: "run",
          sandbox: held,
          code: "def run(i, c): return 1",
        }),
      );
      assert.match(stray.message, /run takes no sandbox.*commands_create/);
      const afterStray = body(
        await read({ action: "list", kind: "run", detail: "full" }),
      );
      assert.equal(afterStray.data.data.length, before.data.data.length);

      // A delete without a person's yes sends nothing; with one, it destroys.
      const noAsk = failure(
        await call("lbb_sandboxes_delete", { sandbox: held }),
      );
      assert.equal(noAsk.code, "approval_required");
      const still = body(await read({ action: "retrieve", sandbox: held }));
      assert.equal(still.data.status, "running");
      const declined = await connected(url, false);
      try {
        const answer = failure(
          await declined.callTool({
            name: "lbb_sandboxes_delete",
            arguments: { graph, sandbox: held },
          }),
        );
        assert.equal(answer.code, "approval_declined");
      } finally {
        await declined.close();
      }
      assert.equal(
        body(await read({ action: "retrieve", sandbox: held })).data.status,
        "running",
      );
      const destroyed = body(
        await approving.callTool({
          name: "lbb_sandboxes_delete",
          arguments: { graph, sandbox: held },
        }),
      );
      assert.match(destroyed.data.status, /^(destroying|destroyed)$/);
      held = undefined;
    } finally {
      if (held) {
        // Clean up a sandbox this test left, through the approving client.
        await approving
          .callTool({
            name: "lbb_sandboxes_delete",
            arguments: { graph, sandbox: held },
          })
          .catch(() => undefined);
      }
      await client.close();
      await approving.close();
    }
  },
);

test(
  "a local server with no sandbox backend answers in plain words",
  { skip: !offUrl },
  async () => {
    const client = await connected(offUrl as string, true);
    try {
      for (const [name, args] of [
        ["lbb_sandboxes", { action: "list" }],
        ["lbb_sandboxes_manage", { action: "run", code: "pass" }],
        ["lbb_sandboxes_delete", { sandbox: "sbx_0000000000001" }],
      ] as const) {
        const error = failure(
          await client.callTool({ name, arguments: { graph, ...args } }),
        );
        assert.equal(error.code, "sandbox_not_enabled", name);
        assert.equal(error.message, SANDBOX_NOT_ENABLED_TEXT, name);
      }
    } finally {
      await client.close();
    }
  },
);
