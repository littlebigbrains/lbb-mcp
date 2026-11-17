import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LbbClient,
  type FetchLike,
  type Schemas,
} from "@littlebigbrain/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildLbbServer } from "./server.js";
import {
  SANDBOX_CLIENT_TOO_OLD_TEXT,
  SANDBOX_NOT_ENABLED_TEXT,
  SANDBOX_NO_ROUTES_TEXT,
  SANDBOX_READ_BYTES_MAX,
  SANDBOX_TIMING,
} from "./sandboxes-tool.js";
import {
  connect as connectTools,
  ok,
  payload,
  sent,
  type Call,
  type Elicit,
} from "./test-support.js";
import type { LbbServerOptions } from "./query-observer.js";

/** A server with the sandbox tools registered. */
function connect(
  fetch: FetchLike,
  options?: LbbServerOptions,
  elicit?: Elicit,
  elicitation?: Record<string, object>,
  clientOptions?: { maxRetries?: number },
) {
  return connectTools(
    fetch,
    { sandboxes: true, ...options },
    elicit,
    elicitation,
    clientOptions,
  );
}

const SBX = "sbx_0000000000001";
const CMD = "cmd_0000000000001";

type Sandbox = Schemas["Sandbox"];
type Command = Schemas["SandboxCommand"];

function sandbox(over: Partial<Sandbox> = {}): Sandbox {
  return {
    id: SBX,
    object: "sandbox",
    created: 1_793_174_400,
    created_by: "key:k1",
    expires_at: 1_793_178_000,
    auto_stop_seconds: 300,
    kind: "sandbox",
    limits: { vcpus: 1, memory_mib: 1024, disk_mib: 4096 },
    metadata: {},
    status: "running",
    template: { id: "sbt_lbb_python", name: "lbb/python" },
    usage: { vcpu_seconds: 0, memory_gib_seconds: 0, disk_gib_seconds: 0 },
    ...over,
  };
}

function stream(tail = "", bytes = tail.length) {
  return { bytes, tail, truncated_bytes: 0 };
}

function command(over: Partial<Command> = {}): Command {
  return {
    id: CMD,
    object: "sandbox_command",
    sandbox: SBX,
    created: 1_793_174_401,
    env_names: [],
    status: "exited",
    exit_code: 0,
    stdin_bytes: 0,
    timeout_ms: 60_000,
    stdout: stream(),
    stderr: stream(),
    ...over,
  };
}

function runSandbox(run: Partial<NonNullable<Sandbox["run"]>>): Sandbox {
  return sandbox({
    kind: "run",
    status: "destroyed",
    status_reason: "run_ended",
    run: { command: CMD, status: "exited", exit_code: 0, ...run },
  });
}

/** A fake fetch that records every call and answers by `route`. */
type Reply = Awaited<ReturnType<FetchLike>>;
function recording(route: (call: Call, n: number) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = { input, init: init ?? {} };
    calls.push(call);
    return route(call, calls.length);
  };
  return { calls, fetch };
}

const failure = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  text: async () =>
    JSON.stringify({
      error: { type: "conflict_error", code, message, param: null },
    }),
});

async function call(
  client: Awaited<ReturnType<typeof connect>>,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({ name, arguments: args });
}

function errorOf(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (
    result.structuredContent as {
      error: { code: string; message: string; status: number | null };
    }
  ).error;
}

test("the sandbox tools are read only, mutating and destructive, with the verbs of the design", async () => {
  const client = await connect(async () => ok());
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.lbb_sandboxes.annotations?.readOnlyHint, true);
    assert.equal(byName.lbb_sandboxes_manage.annotations?.readOnlyHint, false);
    // It can remove data (files_delete, stop) and runs any program, so it is
    // marked destructive; it asks nobody, and it is not idempotent.
    assert.equal(
      byName.lbb_sandboxes_manage.annotations?.destructiveHint,
      true,
    );
    assert.equal(
      byName.lbb_sandboxes_manage.annotations?.idempotentHint,
      undefined,
    );
    assert.match(
      byName.lbb_sandboxes_manage.description ?? "",
      /files_delete cannot be undone, stop ends running commands/,
    );
    assert.equal(
      byName.lbb_sandboxes_delete.annotations?.destructiveHint,
      true,
    );
    const actions = (name: string) =>
      (
        byName[name].inputSchema as {
          properties: Record<string, { enum?: string[] }>;
        }
      ).properties.action?.enum;
    assert.deepEqual(actions("lbb_sandboxes"), [
      "retrieve",
      "list",
      "templates_list",
      "templates_retrieve",
      "commands_list",
      "commands_retrieve",
      "commands_logs",
      "files_list",
      "files_read",
    ]);
    assert.deepEqual(actions("lbb_sandboxes_manage"), [
      "run",
      "create",
      "update",
      "stop",
      "resume",
      "templates_create",
      "commands_create",
      "commands_cancel",
      "files_write",
      "files_delete",
    ]);
    // Every description says how access to sandboxes opens.
    for (const name of [
      "lbb_sandboxes",
      "lbb_sandboxes_manage",
      "lbb_sandboxes_delete",
    ]) {
      assert.match(
        byName[name].description ?? "",
        /Access to sandboxes opens by invitation/,
      );
      assert.match(byName[name].description ?? "", /sandbox_not_enabled/);
    }
    // Object-valued arguments are advertised with their JSON types.
    const manage = byName.lbb_sandboxes_manage.inputSchema as {
      properties: Record<string, { type?: string; anyOf?: unknown[] }>;
    };
    assert.ok(Array.isArray(manage.properties.input?.anyOf));
    assert.equal(manage.properties.limits?.type, "object");
    assert.equal(manage.properties.argv?.type, "array");
    // The input is strict: an argument no action takes is refused.
    for (const name of [
      "lbb_sandboxes",
      "lbb_sandboxes_manage",
      "lbb_sandboxes_delete",
    ]) {
      assert.equal(
        (byName[name].inputSchema as { additionalProperties?: boolean })
          .additionalProperties,
        false,
        name,
      );
    }
    // The three descriptions keep to the words that matter: access by
    // invitation, no promise, and no name of a setting or a backend.
    for (const name of [
      "lbb_sandboxes",
      "lbb_sandboxes_manage",
      "lbb_sandboxes_delete",
    ]) {
      assert.match(
        byName[name].description ?? "",
        /Access to sandboxes opens by invitation/,
      );
      assert.doesNotMatch(
        byName[name].description ?? "",
        /\bVM\b| yet\b|LBB_SANDBOX|Docker|docker/,
      );
    }
  } finally {
    await client.close();
  }
});

test("lbb_sandboxes reads one sandbox, a page of them with every filter, and the templates", async () => {
  const { calls, fetch } = recording(({ input }) => {
    const path = new URL(input).pathname;
    if (path === "/v1/sandboxes/get") return ok(sandbox());
    if (path === "/v1/sandboxes/templates/get")
      return ok({
        id: "sbt_lbb_python",
        object: "sandbox_template",
        name: "lbb/python",
        base: "lbb/python",
        builtin: true,
        revoked: false,
        created: 1,
        timeout_ms: 60_000,
        limits: { vcpus: 1, memory_mib: 1024, disk_mib: 4096 },
        code: "def run(input, config):\n    return input\n",
        config: { unit: "cm" },
      });
    return ok({
      object: "list",
      data: [sandbox()],
      has_more: true,
      next_cursor: "c2",
    });
  });
  const client = await connect(fetch);
  try {
    const one = payload(
      await call(client, "lbb_sandboxes", {
        action: "retrieve",
        sandbox: SBX,
      }),
    );
    assert.match(one.summary, /^sandbox sbx_0000000000001 running/);
    assert.equal((one.data as Sandbox).id, SBX);

    const page = payload(
      await call(client, "lbb_sandboxes", {
        action: "list",
        status: "running",
        template: "normalize",
        workflow: "wf",
        created_by: "key:k1",
        kind: "run",
        cursor: "c1",
        limit: 2,
      }),
    );
    assert.equal(
      (page.data as { next_cursor: string }).next_cursor,
      "c2",
      "the cursor of the next page is kept whole",
    );
    await call(client, "lbb_sandboxes", { action: "templates_list" });
    const template = payload(
      await call(client, "lbb_sandboxes", {
        action: "templates_retrieve",
        template: "sbt_lbb_python",
      }),
    );
    assert.equal(
      (template.data as { code: string }).code,
      "def run(input, config):\n    return input\n",
      "the code of a template is shown whole at the default detail",
    );
    const seen = calls.map(sent);
    assert.deepEqual(
      seen.map((entry) => [entry.method, entry.path]),
      [
        ["GET", "/v1/sandboxes/get"],
        ["GET", "/v1/sandboxes"],
        ["GET", "/v1/sandboxes/templates"],
        ["GET", "/v1/sandboxes/templates/get"],
      ],
    );
    assert.equal(seen[0].query.id, SBX);
    assert.equal(seen[0].query.graph, "g");
    assert.deepEqual(
      {
        status: seen[1].query.status,
        template: seen[1].query.template,
        workflow: seen[1].query.workflow,
        created_by: seen[1].query.created_by,
        kind: seen[1].query.kind,
        cursor: seen[1].query.cursor,
        limit: seen[1].query.limit,
      },
      {
        status: "running",
        template: "normalize",
        workflow: "wf",
        created_by: "key:k1",
        kind: "run",
        cursor: "c1",
        limit: "2",
      },
    );
    assert.equal(seen[3].query.id, "sbt_lbb_python");
  } finally {
    await client.close();
  }
});

test("lbb_sandboxes reads commands and their output by byte offset", async () => {
  const { calls, fetch } = recording(({ input }) => {
    const path = new URL(input).pathname;
    if (path === "/v1/sandboxes/commands/logs")
      return ok({
        object: "sandbox_log",
        data: [
          {
            object: "sandbox_log_frame",
            stream: "stderr",
            offset: 100,
            text: "Traceback (most recent call last):\n",
          },
        ],
        next_offset: 135,
        done: false,
        gap: { from: 10, to: 100 },
      });
    if (path === "/v1/sandboxes/commands/get")
      return ok(
        command({
          status: "exited",
          exit_code: 1,
          stderr: stream("ValueError: bad input\n"),
        }),
      );
    return ok({
      object: "list",
      data: [command()],
      has_more: false,
      next_cursor: null,
    });
  });
  const client = await connect(fetch);
  try {
    await call(client, "lbb_sandboxes", {
      action: "commands_list",
      sandbox: SBX,
      status: "exited",
      limit: 3,
    });
    const got = payload(
      await call(client, "lbb_sandboxes", {
        action: "commands_retrieve",
        sandbox: SBX,
        command: CMD,
      }),
    );
    assert.match(got.summary, /exited with exit code 1/);
    assert.equal(
      (got.data as { stderr: { tail: string } }).stderr.tail,
      "ValueError: bad input\n",
    );
    const logs = payload(
      await call(client, "lbb_sandboxes", {
        action: "commands_logs",
        sandbox: SBX,
        command: CMD,
        stream: "stderr",
        offset: 100,
        max_bytes: 4_000,
      }),
    );
    const data = logs.data as {
      text: string;
      next_offset: number;
      gap: { from: number; to: number };
    };
    assert.equal(data.text, "Traceback (most recent call last):\n");
    assert.deepEqual(data.gap, { from: 10, to: 100 });
    assert.deepEqual(logs.next, {
      action: "commands_logs",
      sandbox: SBX,
      command: CMD,
      stream: "stderr",
      offset: 135,
    });
    const [list, , page] = calls.map(sent);
    assert.equal(list.path, "/v1/sandboxes/commands");
    assert.deepEqual(
      [list.query.sandbox, list.query.status, list.query.limit],
      [SBX, "exited", "3"],
    );
    assert.deepEqual(
      [
        page.query.sandbox,
        page.query.id,
        page.query.stream,
        page.query.offset,
        page.query.limit,
      ],
      [SBX, CMD, "stderr", "100", "4000"],
    );
  } finally {
    await client.close();
  }
});

test("lbb_sandboxes lists a workspace directory and reads a file as text, as base64 or by range", async () => {
  const text = "name,qty\nbolt,3\n";
  const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  const { calls, fetch } = recording(({ input, init }) => {
    const url = new URL(input);
    if (url.pathname === "/v1/sandboxes/files")
      return ok({
        object: "list",
        data: [
          {
            object: "sandbox_file",
            path: "/workspace/data.csv",
            type: "file",
            bytes: text.length,
            modified: 1,
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    const path = url.searchParams.get("path");
    const range = (init?.headers as Record<string, string>).range;
    if (path === "missing-range" && range)
      return failure(416, "range_not_satisfiable", "no byte");
    if (path === "empty.txt")
      return range
        ? failure(416, "range_not_satisfiable", "no byte")
        : { ok: true, status: 200, text: async () => "" };
    const bytes =
      path === "archive.xlsx" ? binary : new TextEncoder().encode(text);
    const [, from, to] = /bytes=(\d+)-(\d*)/.exec(range ?? "bytes=0-") ?? [];
    const part = bytes.subarray(
      Number(from),
      to ? Math.min(Number(to) + 1, bytes.length) : bytes.length,
    );
    return {
      ok: true,
      status: 206,
      text: async () => "",
      arrayBuffer: async () =>
        part.buffer.slice(
          part.byteOffset,
          part.byteOffset + part.byteLength,
        ) as ArrayBuffer,
    };
  });
  const client = await connect(fetch);
  try {
    const listed = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_list",
        sandbox: SBX,
        recursive: true,
      }),
    );
    assert.equal((listed.data as { data: unknown[] }).data.length, 1);
    const whole = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "data.csv",
      }),
    );
    assert.deepEqual(whole.data, {
      path: "data.csv",
      offset: 0,
      bytes: text.length,
      encoding: "utf-8",
      text,
    });
    assert.equal(whole.next, undefined, "the whole file needs no next call");
    // A window shorter than the file names the next offset, and a cut that
    // ends inside a character gives its bytes back.
    const window = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "data.csv",
        max_bytes: 5,
      }),
    );
    assert.equal((window.data as { text: string }).text, "name,");
    assert.deepEqual(window.next, {
      action: "files_read",
      sandbox: SBX,
      path: "data.csv",
      offset: 5,
      max_bytes: 5,
    });
    const rest = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "data.csv",
        offset: 5,
        max_bytes: 100,
      }),
    );
    assert.equal((rest.data as { text: string }).text, text.slice(5));
    const bin = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "archive.xlsx",
      }),
    );
    assert.deepEqual(bin.data, {
      path: "archive.xlsx",
      offset: 0,
      bytes: 6,
      encoding: "base64",
      data: Buffer.from(binary).toString("base64"),
    });
    const empty = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "empty.txt",
      }),
    );
    assert.equal((empty.data as { text: string }).text, "");
    const past = errorOf(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "missing-range",
        offset: 99,
      }),
    );
    assert.equal(past.code, "range_not_satisfiable");
    assert.match(past.message, /at or past the end/);
    const reads = calls
      .map(sent)
      .filter((entry) => entry.path.endsWith("content"));
    assert.equal(reads[0].query.path, "data.csv");
    assert.equal(
      calls[1].init.headers?.["range" as never],
      `bytes=0-${8_000}`,
      "one byte more than the window tells whether the file goes on",
    );
  } finally {
    await client.close();
  }
});

test("a file with control characters stays inside the output budget at the largest read", async () => {
  const noisy = new TextEncoder().encode(
    "\u0001".repeat(SANDBOX_READ_BYTES_MAX),
  );
  const client = await connect(async () => ({
    ok: true,
    status: 206,
    text: async () => "",
    arrayBuffer: async () => noisy.buffer.slice(0),
  }));
  try {
    const result = await call(client, "lbb_sandboxes", {
      action: "files_read",
      sandbox: SBX,
      path: "noise",
      max_bytes: SANDBOX_READ_BYTES_MAX,
    });
    assert.notEqual(result.isError, true);
    const text = (result.content as { text: string }[])[0].text;
    assert.ok(text.length <= 80_000, String(text.length));
  } finally {
    await client.close();
  }
});

test("a missing argument is refused before any request", async () => {
  const { calls, fetch } = recording(() => ok());
  const client = await connect(fetch);
  try {
    for (const [name, args] of [
      ["lbb_sandboxes", { action: "retrieve" }],
      ["lbb_sandboxes", { action: "commands_retrieve", sandbox: SBX }],
      ["lbb_sandboxes", { action: "commands_logs", command: CMD }],
      ["lbb_sandboxes", { action: "files_read", sandbox: SBX }],
      ["lbb_sandboxes", { action: "templates_retrieve" }],
      ["lbb_sandboxes_manage", { action: "stop" }],
      ["lbb_sandboxes_manage", { action: "update", sandbox: SBX }],
      ["lbb_sandboxes_manage", { action: "templates_create" }],
      ["lbb_sandboxes_manage", { action: "commands_create", sandbox: SBX }],
      [
        "lbb_sandboxes_manage",
        { action: "commands_create", sandbox: SBX, argv: ["ls"], code: "x" },
      ],
      ["lbb_sandboxes_manage", { action: "commands_cancel", sandbox: SBX }],
      [
        "lbb_sandboxes_manage",
        { action: "files_write", sandbox: SBX, path: "a" },
      ],
      [
        "lbb_sandboxes_manage",
        {
          action: "files_write",
          sandbox: SBX,
          path: "a",
          text: "x",
          base64: "eA==",
        },
      ],
      ["lbb_sandboxes_manage", { action: "files_delete", sandbox: SBX }],
      ["lbb_sandboxes_manage", { action: "run", wait_ms: 30_001 }],
      [
        "lbb_sandboxes",
        {
          action: "files_read",
          sandbox: SBX,
          path: "a",
          max_bytes: SANDBOX_READ_BYTES_MAX + 1,
        },
      ],
    ] as const) {
      const result = await call(client, name, { ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.deepEqual(calls, [], "an incomplete call sends nothing");
  } finally {
    await client.close();
  }
});

test("run makes one call with a key, and shows the result of a run that worked", async () => {
  const { calls, fetch } = recording(() =>
    ok(runSandbox({ result: { total: 6 } })),
  );
  const client = await connect(fetch);
  try {
    const result = await call(client, "lbb_sandboxes_manage", {
      action: "run",
      code: "def run(input, config):\n    return {'total': sum(input)}",
      input: [1, 2, 3],
      config: { unit: "cm" },
      limits: { memory_mib: 2048 },
      metadata: { purpose: "sum" },
      timeout_ms: 5_000,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const body = payload(result);
    assert.match(body.summary, /exited with code 0/);
    assert.deepEqual(body.data, {
      ok: true,
      status: "exited",
      exit_code: 0,
      command: CMD,
      sandbox: (body.data as { sandbox: unknown }).sandbox,
      result: { total: 6 },
    });
    assert.deepEqual(
      (body.data as { sandbox: unknown }).sandbox,
      {
        id: SBX,
        status: "destroyed",
        status_reason: "run_ended",
        template: { id: "sbt_lbb_python", name: "lbb/python" },
      },
      "the compact answer names the sandbox of the run",
    );
    const standard = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "run",
        code: "x",
        detail: "standard",
      }),
    );
    const record = (
      standard.data as { sandbox: { run: Record<string, unknown> } }
    ).sandbox;
    assert.equal(record.run.result, undefined, "the result is shown once");
    assert.equal(record.run.command, CMD);
    const post = sent(calls[0]);
    assert.equal(post.method, "POST");
    assert.equal(post.path, "/v1/sandboxes");
    assert.match(post.key ?? "", /^sandboxes\.run:/);
    assert.deepEqual(post.body, {
      limits: { memory_mib: 2048 },
      metadata: { purpose: "sum" },
      run: {
        code: "def run(input, config):\n    return {'total': sum(input)}",
        input: [1, 2, 3],
        config: { unit: "cm" },
        timeout_ms: 5_000,
      },
      wait_ms: 30_000,
    });
    // Two calls make two keys; one the caller names is used as it is.
    await call(client, "lbb_sandboxes_manage", { action: "run", input: 1 });
    await call(client, "lbb_sandboxes_manage", {
      action: "run",
      input: 1,
      idempotency_key: "mine-1",
    });
    const keys = calls.map((entry) => sent(entry).key);
    assert.notEqual(keys[1], keys[0]);
    assert.notEqual(keys[2], keys[1]);
    assert.equal(keys[3], "mine-1");
  } finally {
    await client.close();
  }
});

test("a run whose code raised shows the end of its output and is not an error", async () => {
  const { calls, fetch } = recording(({ input }) =>
    new URL(input).pathname === "/v1/sandboxes/commands/get"
      ? ok(
          command({
            status: "exited",
            exit_code: 1,
            stderr: stream("x".repeat(3_000) + "ZeroDivisionError\n"),
          }),
        )
      : ok(runSandbox({ status: "exited", exit_code: 1 })),
  );
  const client = await connect(fetch);
  try {
    const result = await call(client, "lbb_sandboxes_manage", {
      action: "run",
      code: "1/0",
    });
    assert.notEqual(result.isError, true);
    const body = payload(result);
    const data = body.data as {
      ok: boolean;
      command_record: {
        stderr: { tail: string; tail_chars_omitted?: number };
        result?: unknown;
      };
    };
    assert.equal(data.ok, false);
    assert.match(body.summary, /did not work: exited with exit code 1/);
    assert.ok(data.command_record.stderr.tail.endsWith("ZeroDivisionError\n"));
    assert.ok(
      (data.command_record.stderr.tail_chars_omitted ?? 0) > 0,
      "the compact detail shows the end of a long tail, and says what it left out",
    );
    assert.equal(body.truncated, true);
    assert.deepEqual(body.next, { detail: "standard" });
    const full = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "run",
        code: "1/0",
        detail: "full",
      }),
    );
    assert.equal(
      (full.data as typeof data).command_record.stderr.tail.length,
      3_000 + "ZeroDivisionError\n".length,
    );
    assert.equal(
      calls.filter((entry) => sent(entry).path === "/v1/sandboxes/commands/get")
        .length,
      2,
    );
  } finally {
    await client.close();
  }
});

test("a run that outlives its wait comes back as running, with the ids to read it", async () => {
  const { calls, fetch } = recording(() =>
    ok(
      sandbox({
        kind: "run",
        run: { command: CMD, status: "running" },
      }),
    ),
  );
  const client = await connect(fetch);
  try {
    const started = Date.now();
    const body = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "run",
        code: "import time; time.sleep(60)",
        wait_ms: 0,
      }),
    );
    assert.ok(Date.now() - started < 2_000, "wait_ms 0 does not poll");
    assert.equal(calls.length, 1);
    assert.equal(
      sent(calls[0]).body &&
        (sent(calls[0]).body as { wait_ms: number }).wait_ms,
      0,
    );
    assert.match(body.summary, /has not ended \(running\)/);
    assert.deepEqual(
      {
        running: (body.data as { running: boolean }).running,
        command: (body.data as { command: string }).command,
      },
      { running: true, command: CMD },
    );
  } finally {
    await client.close();
  }
});

test("a one-call run whose VM was lost goes again under the next key, twice at most", async () => {
  const { calls, fetch } = recording(({ input }) =>
    new URL(input).pathname === "/v1/sandboxes/commands/get"
      ? ok(
          command({
            status: "lost",
            exit_code: undefined,
            reason: "host_lost",
          }),
        )
      : ok(runSandbox({ status: "lost" })),
  );
  const client = await connect(fetch);
  try {
    const body = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "run",
        code: "pass",
        idempotency_key: "k",
      }),
    );
    const keys = calls
      .map(sent)
      .filter((entry) => entry.method === "POST")
      .map((entry) => entry.key);
    assert.deepEqual(keys, ["k", "k.2", "k.3"]);
    assert.equal((body.data as { status: string }).status, "lost");
    assert.equal((body.data as { ok: boolean }).ok, false);
  } finally {
    await client.close();
  }
});

test("a retry after a 5xx sends the same key, so a run is made once", async () => {
  const { calls, fetch } = recording((_call, n) =>
    n === 1
      ? { ok: false, status: 503, text: async () => "{}" }
      : ok(runSandbox({ result: 1 })),
  );
  const client = await connect(fetch);
  try {
    const result = await call(client, "lbb_sandboxes_manage", {
      action: "run",
      code: "pass",
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const posts = calls.map(sent).filter((entry) => entry.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[1].key, posts[0].key);
  } finally {
    await client.close();
  }
});

test("a result over the budget of its detail level is cut and says so", async () => {
  const big = {
    rows: Array.from({ length: 2_000 }, (_, n) => ({ n, text: "abc" })),
  };
  const { fetch } = recording(() => ok(runSandbox({ result: big })));
  const client = await connect(fetch);
  try {
    const compact = payload(
      await call(client, "lbb_sandboxes_manage", { action: "run", code: "x" }),
    );
    const data = compact.data as {
      result?: unknown;
      result_preview?: string;
      result_chars?: number;
    };
    assert.equal(data.result, undefined);
    assert.equal(data.result_preview?.length, 4_000);
    assert.equal(data.result_chars, JSON.stringify(big).length);
    assert.equal(compact.truncated, true);
    const full = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "run",
        code: "x",
        detail: "full",
      }),
    );
    assert.equal(
      (full.data as { result_preview?: string }).result_preview?.length,
      40_000,
    );
    const text = JSON.stringify(full, null, 2);
    assert.ok(text.length <= 80_000, String(text.length));
  } finally {
    await client.close();
  }
});

test("create, update, stop and resume send their routes; create sends a key", async () => {
  const { calls, fetch } = recording(() => ok(sandbox({ status: "stopped" })));
  const client = await connect(fetch);
  try {
    await call(client, "lbb_sandboxes_manage", {
      action: "create",
      template: "normalize",
      limits: { vcpus: 2 },
      auto_stop_seconds: 60,
      expires_in_seconds: 600,
      metadata: { a: "b" },
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "update",
      sandbox: SBX,
      auto_stop_seconds: 120,
      metadata: { c: "d" },
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "stop",
      sandbox: SBX,
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "resume",
      sandbox: SBX,
    });
    const [create, update, stop, resume] = calls.map(sent);
    assert.deepEqual(
      [create.method, create.path, update.path, stop.path, resume.path],
      [
        "POST",
        "/v1/sandboxes",
        "/v1/sandboxes/update",
        "/v1/sandboxes/stop",
        "/v1/sandboxes/resume",
      ],
    );
    assert.match(create.key ?? "", /^sandboxes\.create:/);
    assert.deepEqual(create.body, {
      template: "normalize",
      limits: { vcpus: 2 },
      auto_stop_seconds: 60,
      expires_in_seconds: 600,
      metadata: { a: "b" },
    });
    assert.equal(update.query.id, SBX);
    assert.deepEqual(update.body, {
      auto_stop_seconds: 120,
      metadata: { c: "d" },
    });
    assert.equal(stop.query.id, SBX);
    assert.equal(resume.query.id, SBX);
  } finally {
    await client.close();
  }
});

test("templates_create saves a version under a key, and a template shows its code", async () => {
  const { calls, fetch } = recording(() =>
    ok({
      id: "sbt_01",
      object: "sandbox_template",
      name: "normalize",
      base: "lbb/python",
      builtin: false,
      revoked: false,
      created: 1,
      timeout_ms: 60_000,
      limits: { vcpus: 1, memory_mib: 2048, disk_mib: 4096 },
      code: "c".repeat(5_000),
    }),
  );
  const client = await connect(fetch);
  try {
    const body = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "templates_create",
        name: "normalize",
        base: "lbb/python",
        code: "def run(input, config): return input",
        config: { unit: "cm" },
        limits: { memory_mib: 2048 },
        timeout_ms: 60_000,
      }),
    );
    const post = sent(calls[0]);
    assert.equal(post.path, "/v1/sandboxes/templates");
    assert.match(post.key ?? "", /^sandboxes\.templates\.create:/);
    assert.deepEqual(post.body, {
      name: "normalize",
      base: "lbb/python",
      code: "def run(input, config): return input",
      limits: { memory_mib: 2048 },
      timeout_ms: 60_000,
      config: { unit: "cm" },
    });
    assert.match(
      body.summary,
      /saved template sbt_01 \(normalize, base lbb\/python\)/,
    );
    // The code is cut to the detail level's budget, with its length.
    const data = body.data as { code: string; code_chars: number };
    assert.equal(data.code.length, 4_000);
    assert.equal(data.code_chars, 5_000);
  } finally {
    await client.close();
  }
});

test("commands_create starts argv or a run, waits 30 seconds, and never sends a lost command again", async () => {
  const { calls, fetch } = recording(() =>
    ok(command({ status: "lost", exit_code: undefined, reason: "host_lost" })),
  );
  const client = await connect(fetch);
  try {
    const argv = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "commands_create",
        sandbox: SBX,
        argv: ["bash", "-lc", "echo hi"],
        cwd: "/workspace/app",
        env: { MODE: "x" },
        stdin: "in",
        timeout_ms: 9_000,
      }),
    );
    assert.match(argv.summary, /lost \(host_lost\)/);
    assert.equal(calls.length, 1, "a lost command is not sent again");
    const [first] = calls.map(sent);
    assert.equal(first.path, "/v1/sandboxes/commands");
    assert.equal(first.query.sandbox, SBX);
    assert.match(first.key ?? "", /^sandboxes\.commands\.create:/);
    assert.deepEqual(first.body, {
      argv: ["bash", "-lc", "echo hi"],
      cwd: "/workspace/app",
      env: { MODE: "x" },
      stdin: "in",
      timeout_ms: 9_000,
      wait_ms: 30_000,
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "commands_create",
      sandbox: SBX,
      input: null,
      wait_ms: 0,
    });
    assert.deepEqual(sent(calls[1]).body, {
      run: { input: null },
      wait_ms: 0,
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "commands_create",
      sandbox: SBX,
      code: "def run(input, config): return input",
      input: { a: 1 },
      timeout_ms: 7_000,
    });
    assert.deepEqual(sent(calls[2]).body, {
      run: {
        code: "def run(input, config): return input",
        input: { a: 1 },
        timeout_ms: 7_000,
      },
      wait_ms: 30_000,
    });
  } finally {
    await client.close();
  }
});

test("a command retried after a 5xx keeps its key; a command the caller sends twice runs twice", async () => {
  let posts = 0;
  const { calls, fetch } = recording(() => {
    posts += 1;
    return posts === 1
      ? { ok: false, status: 503, text: async () => "{}" }
      : ok(command());
  });
  const client = await connect(fetch);
  try {
    const args = {
      action: "commands_create",
      sandbox: SBX,
      argv: ["true"],
    };
    await call(client, "lbb_sandboxes_manage", args);
    const [a, b] = calls.map(sent);
    assert.equal(b.key, a.key, "the retry sends the key of the first try");
    await call(client, "lbb_sandboxes_manage", args);
    assert.notEqual(sent(calls[2]).key, a.key, "a new call makes a new key");
    await call(client, "lbb_sandboxes_manage", {
      ...args,
      idempotency_key: "same",
    });
    await call(client, "lbb_sandboxes_manage", {
      ...args,
      idempotency_key: "same",
    });
    assert.equal(sent(calls[3]).key, "same");
    assert.equal(sent(calls[4]).key, "same");
  } finally {
    await client.close();
  }
});

test("commands_cancel, files_write and files_delete send their routes", async () => {
  const { calls, fetch } = recording(({ input }) => {
    const path = new URL(input).pathname;
    if (path === "/v1/sandboxes/commands/cancel")
      return ok(
        command({
          status: "cancelled",
          reason: "request",
          exit_code: undefined,
        }),
      );
    if (path === "/v1/sandboxes/files/content")
      return ok({
        object: "sandbox_file",
        path: "/workspace/a.txt",
        type: "file",
        bytes: 2,
        modified: 1,
      });
    return ok({
      object: "sandbox_file",
      path: "/workspace/a.txt",
      deleted: true,
    });
  });
  const client = await connect(fetch);
  try {
    const cancelled = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "commands_cancel",
        sandbox: SBX,
        command: CMD,
        grace_ms: 1_000,
      }),
    );
    assert.match(cancelled.summary, /cancelled \(request\)/);
    await call(client, "lbb_sandboxes_manage", {
      action: "files_write",
      sandbox: SBX,
      path: "a.txt",
      text: "hi",
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "files_write",
      sandbox: SBX,
      path: "b.bin",
      base64: Buffer.from([0, 1, 255]).toString("base64"),
    });
    await call(client, "lbb_sandboxes_manage", {
      action: "files_delete",
      sandbox: SBX,
      path: "out",
      recursive: true,
    });
    const [cancel, write, binary, remove] = calls;
    assert.deepEqual(sent(cancel).body, { grace_ms: 1_000 });
    assert.equal(sent(cancel).query.id, CMD);
    assert.equal(write.init.method, "PUT");
    assert.equal(new URL(write.input).searchParams.get("path"), "a.txt");
    assert.equal(
      new TextDecoder().decode(write.init.body as unknown as Uint8Array),
      "hi",
    );
    assert.deepEqual(
      [...(binary.init.body as unknown as Uint8Array)],
      [0, 1, 255],
      "bytes that are not text arrive exact",
    );
    assert.equal(remove.init.method, "DELETE");
    assert.equal(new URL(remove.input).searchParams.get("recursive"), "true");
  } finally {
    await client.close();
  }
});

test("lbb_sandboxes_delete asks the person first and sends nothing without a yes", async () => {
  const { calls, fetch } = recording(({ init }) =>
    init?.method === "DELETE"
      ? ok(sandbox({ status: "destroying", status_reason: "requested" }))
      : ok(sandbox()),
  );
  // No client that can ask: nothing is sent, not even the read.
  const cannotAsk = await connect(fetch);
  try {
    const refused = errorOf(
      await call(cannotAsk, "lbb_sandboxes_delete", { sandbox: SBX }),
    );
    assert.equal(refused.code, "approval_required");
    assert.deepEqual(calls, []);
  } finally {
    await cannotAsk.close();
  }

  const questions: string[] = [];
  const declines = await connect(fetch, undefined, (params) => {
    questions.push(params.message);
    return { action: "decline" };
  });
  try {
    const declined = errorOf(
      await call(declines, "lbb_sandboxes_delete", { sandbox: SBX }),
    );
    assert.equal(declined.code, "approval_declined");
    assert.deepEqual(
      calls.map((entry) => sent(entry).method),
      ["GET"],
      "the sandbox is read for the question, and not deleted",
    );
    assert.match(
      questions[0],
      /^Destroy the sandbox sbx_0000000000001 \(template lbb\/python, running\) of graph "g"\? Its running commands end and its workspace is deleted\. This cannot be undone\./,
    );
  } finally {
    await declines.close();
  }

  calls.length = 0;
  const approves = await connect(fetch, undefined, () => ({
    action: "accept",
    content: { confirm: true },
  }));
  try {
    const result = await call(approves, "lbb_sandboxes_delete", {
      sandbox: SBX,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(payload(result).summary, /destroying \(requested\)/);
    const seen = calls.map(sent);
    assert.deepEqual(
      seen.map((entry) => [entry.method, entry.path]),
      [
        ["GET", "/v1/sandboxes/get"],
        ["DELETE", "/v1/sandboxes"],
      ],
    );
    assert.equal(seen[1].query.id, SBX);
  } finally {
    await approves.close();
  }
});

test("the question about a sandbox that has ended says so, and a missing sandbox is not asked about", async () => {
  const questions: string[] = [];
  const { calls, fetch } = recording(({ input }) =>
    input.includes("sbx_gone")
      ? failure(404, "sandbox_not_found", "the graph has no sandbox sbx_gone")
      : ok(sandbox({ status: "destroyed" })),
  );
  const client = await connect(fetch, undefined, (params) => {
    questions.push(params.message);
    return { action: "accept", content: { confirm: true } };
  });
  try {
    await call(client, "lbb_sandboxes_delete", { sandbox: SBX });
    assert.match(
      questions[0],
      /has ended already \(destroyed\), so this changes nothing/,
    );
    const missing = errorOf(
      await call(client, "lbb_sandboxes_delete", { sandbox: "sbx_gone" }),
    );
    assert.equal(missing.code, "sandbox_not_found");
    assert.equal(
      questions.length,
      1,
      "nobody is asked about a sandbox that does not exist",
    );
    assert.ok(
      !calls.some(
        (entry) =>
          sent(entry).method === "DELETE" && entry.input.includes("sbx_gone"),
      ),
    );
  } finally {
    await client.close();
  }
});

test("a server with no sandbox backend answers in plain words on every tool", async () => {
  const { calls, fetch } = recording(() =>
    failure(
      409,
      "sandbox_not_enabled",
      "Sandboxes are not enabled for this environment.",
    ),
  );
  const client = await connect(fetch, undefined, () => ({
    action: "accept",
    content: { confirm: true },
  }));
  try {
    for (const [name, args] of [
      ["lbb_sandboxes", { action: "list" }],
      ["lbb_sandboxes", { action: "retrieve", sandbox: SBX }],
      ["lbb_sandboxes", { action: "commands_list", sandbox: SBX }],
      ["lbb_sandboxes", { action: "files_list", sandbox: SBX }],
      ["lbb_sandboxes", { action: "files_read", sandbox: SBX, path: "a" }],
      ["lbb_sandboxes_manage", { action: "run", code: "pass" }],
      ["lbb_sandboxes_manage", { action: "create" }],
      [
        "lbb_sandboxes_manage",
        { action: "commands_create", sandbox: SBX, argv: ["ls"] },
      ],
      ["lbb_sandboxes_delete", { sandbox: SBX }],
    ] as const) {
      const error = errorOf(await call(client, name, { ...args }));
      assert.equal(error.code, "sandbox_not_enabled", JSON.stringify(args));
      assert.equal(error.status, 409);
      assert.equal(error.message, SANDBOX_NOT_ENABLED_TEXT);
      // The words an agent needs: nothing ran, how a person gets access, and no promise.
      assert.match(error.message, /nothing ran/);
      assert.match(error.message, /opens by invitation/);
      assert.match(error.message, /product\/sandboxes\/#waitlist/);
      // No setting name and no backend name reach the agent.
      assert.doesNotMatch(error.message, /LBB_SANDBOX|Docker|docker/);
    }
    assert.ok(
      !calls.some((entry) => sent(entry).method === "DELETE"),
      "nothing is deleted on a server with no backend",
    );
  } finally {
    await client.close();
  }
});

test("other errors keep their own code and message", async () => {
  const { fetch } = recording(() =>
    failure(409, "sandbox_not_running", "the sandbox is stopped"),
  );
  const client = await connect(fetch);
  try {
    const error = errorOf(
      await call(client, "lbb_sandboxes_manage", {
        action: "commands_create",
        sandbox: SBX,
        argv: ["ls"],
      }),
    );
    assert.equal(error.code, "sandbox_not_running");
    assert.equal(error.message, "the sandbox is stopped");
  } finally {
    await client.close();
  }
});

test("a server whose build has no sandbox routes answers in plain words, and a missing sandbox does not", async () => {
  const { fetch } = recording(({ input }) =>
    input.includes("sbx_gone")
      ? failure(404, "sandbox_not_found", "the graph has no sandbox sbx_gone")
      : {
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({
              error: {
                type: "not_found_error",
                code: "not_found",
                message:
                  "no route for /v1/sandboxes — did you mean /v1/sandboxes/get?",
                param: null,
              },
            }),
        },
  );
  const client = await connect(fetch);
  try {
    const none = errorOf(
      await call(client, "lbb_sandboxes", { action: "list" }),
    );
    assert.equal(none.code, "not_found");
    assert.equal(none.status, 404);
    assert.equal(none.message, SANDBOX_NO_ROUTES_TEXT);
    assert.match(none.message, /nothing ran/);
    assert.match(none.message, /opens by invitation/);
    assert.doesNotMatch(none.message, /LBB_SANDBOX|Docker|docker/);
    const gone = errorOf(
      await call(client, "lbb_sandboxes", {
        action: "retrieve",
        sandbox: "sbx_gone",
      }),
    );
    assert.equal(gone.code, "sandbox_not_found");
    assert.equal(gone.message, "the graph has no sandbox sbx_gone");
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Round 2: keys, strict input, time cap and cancel, reads, and the setting.
// ---------------------------------------------------------------------------

/** The error of a failed call, with every field the tool adds. */
function failureOf(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (
    result.structuredContent as {
      error: {
        code: string;
        message: string;
        status: number | null;
        idempotency_key?: string;
        outcome?: string;
      };
    }
  ).error;
}

/** The text of a result, for a check that a value is nowhere in it. */
function textOf(result: Awaited<ReturnType<typeof call>>): string {
  return (result.content as { text: string }[]).map((c) => c.text).join("\n");
}

/** `SANDBOX_TIMING`, shortened for one test and restored after it. */
async function withTiming(
  timing: Partial<typeof SANDBOX_TIMING>,
  body: () => Promise<void>,
): Promise<void> {
  const before = { ...SANDBOX_TIMING };
  Object.assign(SANDBOX_TIMING, timing);
  try {
    await body();
  } finally {
    Object.assign(SANDBOX_TIMING, before);
  }
}

const TEMPLATE = {
  id: "sbt_01",
  object: "sandbox_template",
  name: "normalize",
  base: "lbb/python",
  builtin: false,
  revoked: false,
  created: 1,
  timeout_ms: 60_000,
  limits: { vcpus: 1, memory_mib: 1024, disk_mib: 4096 },
};

test("every answer of a call that runs code returns its key, the tool's or the caller's", async () => {
  const { calls, fetch } = recording(({ input }) => {
    const path = new URL(input).pathname;
    if (path === "/v1/sandboxes/templates") return ok(TEMPLATE);
    if (path === "/v1/sandboxes/commands") return ok(command());
    if (path === "/v1/sandboxes") return ok(runSandbox({ result: 1 }));
    return ok(sandbox());
  });
  const client = await connect(fetch);
  try {
    const cases = [
      ["run", { code: "x" }, /^sandboxes\.run:/],
      ["create", {}, /^sandboxes\.create:/],
      [
        "templates_create",
        { name: "normalize" },
        /^sandboxes\.templates\.create:/,
      ],
      [
        "commands_create",
        { sandbox: SBX, argv: ["ls"] },
        /^sandboxes\.commands\.create:/,
      ],
    ] as const;
    for (const [action, args, pattern] of cases) {
      calls.length = 0;
      const made = payload(
        await call(client, "lbb_sandboxes_manage", { action, ...args }),
      ) as { idempotency_key?: string };
      assert.match(made.idempotency_key ?? "", pattern, action);
      assert.equal(
        sent(calls[0]).key,
        made.idempotency_key,
        `${action}: the answer names the key that was sent`,
      );
      const given = payload(
        await call(client, "lbb_sandboxes_manage", {
          action,
          ...args,
          idempotency_key: `mine-${action}`,
        }),
      ) as { idempotency_key?: string };
      assert.equal(given.idempotency_key, `mine-${action}`, action);
    }
    // An action that does not run code makes no key.
    const stop = payload(
      await call(client, "lbb_sandboxes_manage", {
        action: "stop",
        sandbox: SBX,
      }),
    ) as { idempotency_key?: string };
    assert.equal(stop.idempotency_key, undefined);
  } finally {
    await client.close();
  }
});

test("an error of a call that runs code names its key, and a transport failure or a 5xx says the outcome is unknown", async () => {
  const cases = [
    ["run", { code: "x" }, "run"],
    ["create", {}, "sandbox"],
    ["templates_create", { name: "normalize" }, "template"],
    ["commands_create", { sandbox: SBX, argv: ["ls"] }, "command"],
  ] as const;
  const unknown = (noun: string) =>
    new RegExp(
      `The outcome is unknown; send the same idempotency_key to find the same ${noun}\\.$`,
    );
  for (const [action, args, noun] of cases) {
    // A 5xx on every try.
    const down = recording(() => ({
      ok: false,
      status: 503,
      text: async () => "{}",
    }));
    const a = await connect(down.fetch);
    try {
      const error = failureOf(
        await call(a, "lbb_sandboxes_manage", { action, ...args }),
      );
      const keys = new Set(down.calls.map((entry) => sent(entry).key));
      assert.equal(keys.size, 1, `${action}: every try sends one key`);
      assert.equal(error.idempotency_key, [...keys][0], action);
      assert.equal(error.outcome, "unknown", action);
      assert.match(error.message, unknown(noun), action);
    } finally {
      await a.close();
    }
    // A transport failure: the request never answered.
    const broken = recording(() => {
      throw new TypeError("fetch failed");
    });
    const b = await connect(broken.fetch, undefined, undefined, undefined, {
      maxRetries: 1,
    });
    try {
      const error = failureOf(
        await call(b, "lbb_sandboxes_manage", {
          action,
          ...args,
          idempotency_key: "mine",
        }),
      );
      assert.equal(error.idempotency_key, "mine", action);
      assert.equal(error.outcome, "unknown", action);
      assert.match(error.message, unknown(noun), action);
      assert.match(error.message, /fetch failed/);
    } finally {
      await b.close();
    }
    // A refusal of the server says nothing about an unknown outcome, but names the key.
    const refused = recording(() =>
      failure(409, "sandbox_not_running", "the sandbox is stopped"),
    );
    const c = await connect(refused.fetch);
    try {
      const error = failureOf(
        await call(c, "lbb_sandboxes_manage", { action, ...args }),
      );
      assert.equal(error.code, "sandbox_not_running");
      assert.equal(error.message, "the sandbox is stopped");
      assert.equal(error.outcome, undefined);
      assert.match(error.idempotency_key ?? "", /^sandboxes\./);
    } finally {
      await c.close();
    }
  }
});

test("a refusal before any request names the key and sends nothing", async () => {
  const { calls, fetch } = recording(() => ok());
  const client = await connect(fetch);
  try {
    const error = failureOf(
      await call(client, "lbb_sandboxes_manage", {
        action: "commands_create",
        sandbox: SBX,
        idempotency_key: "mine",
      }),
    );
    assert.equal(error.code, "tool_error");
    assert.equal(error.idempotency_key, "mine");
    assert.equal(error.outcome, undefined);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("a tool-made key gives K.2 and K.3 on a lost run, and the answer names every key", async () => {
  const { calls, fetch } = recording(({ input }) =>
    new URL(input).pathname === "/v1/sandboxes/commands/get"
      ? ok(command({ status: "lost", exit_code: undefined }))
      : ok(runSandbox({ status: "lost" })),
  );
  const client = await connect(fetch);
  try {
    const body = payload(
      await call(client, "lbb_sandboxes_manage", { action: "run", code: "x" }),
    ) as unknown as {
      idempotency_key: string;
      data: { attempt_keys: string[]; status: string };
    };
    const keys = calls
      .map(sent)
      .filter((entry) => entry.method === "POST")
      .map((entry) => entry.key);
    assert.match(keys[0] ?? "", /^sandboxes\.run:/);
    assert.deepEqual(keys, [keys[0], `${keys[0]}.2`, `${keys[0]}.3`]);
    assert.equal(body.idempotency_key, keys[0]);
    assert.deepEqual(body.data.attempt_keys, keys);
    assert.equal(body.data.status, "lost");
  } finally {
    await client.close();
  }
});

test("a 503 retry keeps the key for create and templates_create", async () => {
  for (const [action, args, path] of [
    ["create", {}, "/v1/sandboxes"],
    ["templates_create", { name: "normalize" }, "/v1/sandboxes/templates"],
  ] as const) {
    const { calls, fetch } = recording((_call, n) =>
      n === 1
        ? { ok: false, status: 503, text: async () => "{}" }
        : ok(action === "create" ? sandbox() : TEMPLATE),
    );
    const client = await connect(fetch);
    try {
      const result = await call(client, "lbb_sandboxes_manage", {
        action,
        ...args,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const posts = calls.map(sent).filter((entry) => entry.method === "POST");
      assert.equal(posts.length, 2, action);
      assert.equal(posts[0].path, path);
      assert.equal(posts[1].key, posts[0].key, action);
      assert.equal(
        (payload(result) as { idempotency_key?: string }).idempotency_key,
        posts[0].key,
      );
    } finally {
      await client.close();
    }
  }
});

test("a run that ends while the tool polls answers with its result", async () => {
  await withTiming({ pauseMs: 1, pauseMaxMs: 2 }, async () => {
    let reads = 0;
    const { calls, fetch } = recording(({ input }) => {
      if (new URL(input).pathname === "/v1/sandboxes/get") {
        reads += 1;
        return ok(
          reads < 3
            ? sandbox({ kind: "run", run: { command: CMD, status: "running" } })
            : runSandbox({ result: { total: 6 } }),
        );
      }
      return ok(
        sandbox({ kind: "run", run: { command: CMD, status: "running" } }),
      );
    });
    const client = await connect(fetch);
    try {
      const body = payload(
        await call(client, "lbb_sandboxes_manage", {
          action: "run",
          code: "x",
        }),
      );
      assert.deepEqual(
        {
          ok: (body.data as { ok: boolean }).ok,
          result: (body.data as { result: unknown }).result,
        },
        { ok: true, result: { total: 6 } },
      );
      assert.equal(reads, 3, "the tool polled until the run ended");
      assert.equal(
        calls.filter((entry) => sent(entry).method === "POST").length,
        1,
      );
    } finally {
      await client.close();
    }
  });
});

test("a run that outlives the poll limit or the time cap comes back running, with its ids and its key", async () => {
  for (const timing of [
    { pollMs: 40, capMs: 60_000, pauseMs: 5, pauseMaxMs: 5 },
    { pollMs: 60_000, capMs: 40, pauseMs: 5, pauseMaxMs: 5 },
  ]) {
    await withTiming(timing, async () => {
      const { calls, fetch } = recording(() =>
        ok(sandbox({ kind: "run", run: { command: CMD, status: "running" } })),
      );
      const client = await connect(fetch);
      try {
        const started = Date.now();
        const result = await call(client, "lbb_sandboxes_manage", {
          action: "run",
          code: "x",
          idempotency_key: "mine",
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.ok(Date.now() - started < 2_000, "the call ended at its limit");
        const body = payload(result) as unknown as {
          idempotency_key: string;
          data: { running: boolean; command: string; sandbox: { id: string } };
        };
        assert.equal(body.data.running, true);
        assert.equal(body.data.command, CMD);
        assert.equal(body.data.sandbox.id, SBX);
        assert.equal(body.idempotency_key, "mine");
        assert.ok(
          calls.filter((entry) => sent(entry).path === "/v1/sandboxes/get")
            .length >= 1,
        );
      } finally {
        await client.close();
      }
    });
  }
});

test("a lost run with no time left under the cap is not sent again", async () => {
  await withTiming({ capMs: 0 }, async () => {
    const { calls, fetch } = recording(({ input }) =>
      new URL(input).pathname === "/v1/sandboxes/commands/get"
        ? ok(command({ status: "lost", exit_code: undefined }))
        : ok(runSandbox({ status: "lost" })),
    );
    const client = await connect(fetch);
    try {
      const body = payload(
        await call(client, "lbb_sandboxes_manage", {
          action: "run",
          code: "x",
          idempotency_key: "k",
        }),
      );
      assert.match(body.summary, /the time cap left no room to send it again/);
      assert.equal(
        calls.filter((entry) => sent(entry).method === "POST").length,
        1,
      );
    } finally {
      await client.close();
    }
  });
});

test("a cancel of the call stops the polling and starts no further attempt", async () => {
  await withTiming({ pauseMs: 5, pauseMaxMs: 5 }, async () => {
    let polls = 0;
    const route = recording(({ input }) => {
      if (new URL(input).pathname === "/v1/sandboxes/get") polls += 1;
      return ok(
        sandbox({ kind: "run", run: { command: CMD, status: "running" } }),
      );
    });
    const client = await connect(route.fetch);
    try {
      const abort = new AbortController();
      const pending = client.callTool(
        {
          name: "lbb_sandboxes_manage",
          arguments: { action: "run", code: "x" },
        },
        undefined,
        { signal: abort.signal },
      );
      while (polls < 3) await new Promise((resolve) => setTimeout(resolve, 5));
      abort.abort();
      await assert.rejects(pending);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = route.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(route.calls.length, after, "no request after the cancel");
      assert.equal(
        route.calls.filter((entry) => sent(entry).method === "POST").length,
        1,
        "no further attempt",
      );
    } finally {
      await client.close();
    }
  });
});

test("an argument that does not belong to the action is refused before any request", async () => {
  const { calls, fetch } = recording(() => ok());
  const client = await connect(fetch);
  try {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      // run, create and templates_create make something new: no sandbox.
      [
        "lbb_sandboxes_manage",
        { action: "run", sandbox: SBX, code: "x" },
        /run takes no sandbox.*commands_create/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "create", sandbox: SBX },
        /create takes no sandbox.*commands_create/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "templates_create", name: "n", sandbox: SBX },
        /templates_create takes no sandbox.*commands_create/,
      ],
      // run drops nothing without a word.
      [
        "lbb_sandboxes_manage",
        { action: "run", code: "x", env: { A: "b" } },
        /does not take `env`/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "run", code: "x", stdin: "s" },
        /does not take `stdin`/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "run", argv: ["ls"] },
        /does not take `argv`/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "run", code: "x", cwd: "/workspace" },
        /does not take `cwd`/,
      ],
      // update does not expire a sandbox.
      [
        "lbb_sandboxes_manage",
        { action: "update", sandbox: SBX, expires_in_seconds: 60 },
        /does not take `expires_in_seconds`.*It takes `sandbox`, `auto_stop_seconds`, `metadata`/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "stop", sandbox: SBX, template: "x" },
        /does not take `template`/,
      ],
      [
        "lbb_sandboxes_manage",
        {
          action: "update",
          sandbox: SBX,
          auto_stop_seconds: 60,
          idempotency_key: "k",
        },
        /does not take `idempotency_key`/,
      ],
      [
        "lbb_sandboxes_manage",
        {
          action: "files_write",
          sandbox: SBX,
          path: "a",
          text: "x",
          recursive: true,
        },
        /does not take `recursive`/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "files_delete", sandbox: SBX, path: "a", text: "x" },
        /does not take `text`/,
      ],
      [
        "lbb_sandboxes_manage",
        { action: "commands_cancel", sandbox: SBX, command: CMD, argv: ["ls"] },
        /does not take `argv`/,
      ],
      // The reads.
      [
        "lbb_sandboxes",
        { action: "retrieve", sandbox: SBX, limit: 5 },
        /does not take `limit`/,
      ],
      [
        "lbb_sandboxes",
        { action: "commands_logs", sandbox: SBX, command: CMD, path: "a" },
        /does not take `path`/,
      ],
      [
        "lbb_sandboxes",
        { action: "files_list", sandbox: SBX, max_bytes: 10 },
        /does not take `max_bytes`/,
      ],
      [
        "lbb_sandboxes",
        { action: "list", sandbox: SBX },
        /does not take `sandbox`/,
      ],
    ];
    for (const [name, args, message] of cases) {
      const error = failureOf(await call(client, name, args));
      assert.equal(error.code, "tool_error", JSON.stringify(args));
      assert.match(error.message, message, JSON.stringify(args));
    }
    assert.deepEqual(calls, [], "a stray argument sends nothing");
    // A name that no action takes is refused by the schema.
    for (const [name, args] of [
      [
        "lbb_sandboxes_manage",
        { action: "run", code: "x", idempotencyKey: "k" },
      ],
      ["lbb_sandboxes", { action: "list", Limit: 1 }],
      ["lbb_sandboxes_delete", { sandbox: SBX, confirm: true }],
    ] as const) {
      const result = await call(client, name, { ...args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(textOf(result), /Unrecognized key/, JSON.stringify(args));
    }
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("files_write refuses base64 that is not canonical, before the call", async () => {
  const { calls, fetch } = recording(() =>
    ok({
      object: "sandbox_file",
      path: "/workspace/a",
      type: "file",
      bytes: 1,
      modified: 1,
    }),
  );
  const client = await connect(fetch);
  try {
    for (const base64 of [
      "!!!!",
      "abc",
      "QQ=",
      "QR==",
      "QQ==QQ==",
      "QQ=A",
      "QUJD\n",
      "é",
    ]) {
      const result = await call(client, "lbb_sandboxes_manage", {
        action: "files_write",
        sandbox: SBX,
        path: "a",
        base64,
      });
      assert.match(
        failureOf(result).message,
        /base64 is not valid base64/,
        JSON.stringify(base64),
      );
    }
    assert.deepEqual(calls, []);
    for (const [base64, bytes] of [
      ["", []],
      ["QQ==", [65]],
      ["QUI=", [65, 66]],
      ["QUJD", [65, 66, 67]],
    ] as const) {
      calls.length = 0;
      const result = await call(client, "lbb_sandboxes_manage", {
        action: "files_write",
        sandbox: SBX,
        path: "a",
        base64,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const writes: Call[] = calls;
      assert.deepEqual(
        [...(writes[0].init.body as unknown as Uint8Array)],
        bytes,
      );
    }
  } finally {
    await client.close();
  }
});

/** A fake of the file content route over `files` (path to bytes), with ranges. */
function serving(files: Record<string, Uint8Array>) {
  return recording(({ input, init }) => {
    const url = new URL(input);
    const bytes = files[url.searchParams.get("path") ?? ""];
    if (!bytes) return failure(404, "sandbox_file_not_found", "no such file");
    const range = (init?.headers as Record<string, string>).range;
    const [, from, to] = /bytes=(\d+)-(\d*)/.exec(range ?? "bytes=0-") ?? [];
    const part = bytes.subarray(
      Number(from),
      to ? Math.min(Number(to) + 1, bytes.length) : bytes.length,
    );
    return {
      ok: true,
      status: 206,
      text: async () => "",
      arrayBuffer: async () =>
        part.buffer.slice(
          part.byteOffset,
          part.byteOffset + part.byteLength,
        ) as ArrayBuffer,
    };
  });
}

test("a read with the least window moves on through multibyte text and ends", async () => {
  const text = "a€€€é😀z";
  const { fetch } = serving({ "t.txt": new TextEncoder().encode(text) });
  const client = await connect(fetch);
  try {
    // A window below 4 bytes is refused: no whole character may fit in it.
    for (const max_bytes of [1, 2, 3]) {
      const result = await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "t.txt",
        max_bytes,
      });
      assert.equal(result.isError, true, String(max_bytes));
    }
    let offset = 0;
    let read = "";
    for (let turn = 0; turn < 30; turn += 1) {
      const body = payload(
        await call(client, "lbb_sandboxes", {
          action: "files_read",
          sandbox: SBX,
          path: "t.txt",
          offset,
          max_bytes: 4,
        }),
      ) as {
        data: { bytes: number; text?: string };
        next?: { offset: number };
      };
      assert.ok(body.data.bytes > 0, `turn ${turn} moves on`);
      read += body.data.text ?? "";
      if (!body.next) break;
      assert.ok(body.next.offset > offset, "the next offset grows");
      offset = body.next.offset;
    }
    assert.equal(read, text);
    // A read that starts inside a character answers base64 and still moves on.
    const inside = payload(
      await call(client, "lbb_sandboxes", {
        action: "files_read",
        sandbox: SBX,
        path: "t.txt",
        offset: 2,
        max_bytes: 4,
      }),
    ) as { data: { bytes: number; encoding: string } };
    assert.equal(inside.data.encoding, "base64");
    assert.equal(inside.data.bytes, 4);
  } finally {
    await client.close();
  }
});

test("commands_logs cuts a text over its own limit and moves the next offset with the cut", async () => {
  const { fetch } = recording(() =>
    ok({
      object: "sandbox_log",
      data: [
        {
          object: "sandbox_log_frame",
          stream: "stdout",
          offset: 100,
          text: "x".repeat(50_000),
        },
      ],
      next_offset: 50_100,
      done: true,
    }),
  );
  const client = await connect(fetch);
  try {
    const body = payload(
      await call(client, "lbb_sandboxes", {
        action: "commands_logs",
        sandbox: SBX,
        command: CMD,
        offset: 100,
        max_bytes: 4_000,
      }),
    ) as {
      data: { text: string; next_offset: number; done: boolean };
      next?: { offset: number };
    };
    assert.equal(body.data.text.length, 4_000);
    assert.equal(body.data.next_offset, 4_100);
    assert.equal(body.data.done, false, "what was cut is still to read");
    assert.equal(body.next?.offset, 4_100);
  } finally {
    await client.close();
  }
});

test("a log of control characters at the largest read stays inside the output budget", async () => {
  const { fetch } = recording(() =>
    ok({
      object: "sandbox_log",
      data: [
        {
          object: "sandbox_log_frame",
          stream: "stdout",
          offset: 0,
          text: "\u0001".repeat(SANDBOX_READ_BYTES_MAX),
        },
      ],
      next_offset: SANDBOX_READ_BYTES_MAX,
      done: false,
    }),
  );
  const client = await connect(fetch);
  try {
    const result = await call(client, "lbb_sandboxes", {
      action: "commands_logs",
      sandbox: SBX,
      command: CMD,
      max_bytes: SANDBOX_READ_BYTES_MAX,
    });
    assert.notEqual(result.isError, true);
    assert.ok(textOf(result).length <= 80_000, String(textOf(result).length));
  } finally {
    await client.close();
  }
});

test("a command record with a very large argv stays inside the output budget", async () => {
  const argv = Array.from({ length: 256 }, () => "a".repeat(8 * 1024));
  const { fetch } = recording(() => ok(command({ argv })));
  const client = await connect(fetch);
  try {
    for (const detail of ["compact", "standard", "full"]) {
      const result = await call(client, "lbb_sandboxes_manage", {
        action: "commands_create",
        sandbox: SBX,
        argv: ["ls"],
        detail,
      });
      assert.notEqual(result.isError, true, detail);
      assert.ok(
        textOf(result).length <= 80_000,
        `${detail}: ${textOf(result).length}`,
      );
    }
  } finally {
    await client.close();
  }
});

test("env values and stdin text reach no answer and no log line, also when the server fails", async () => {
  const secrets = ["s3cr3t-token-value", "stdin-secret-text"];
  const events: unknown[] = [];
  for (const route of [
    () => ({ ok: false, status: 503, text: async () => "{}" }),
    () => failure(409, "sandbox_not_running", "the sandbox is stopped"),
    () => ok(command({ env_names: ["TOKEN"], stdin_bytes: 17 })),
  ]) {
    const { fetch } = recording(route);
    const client = await connect(fetch, { log: (event) => events.push(event) });
    try {
      const result = await call(client, "lbb_sandboxes_manage", {
        action: "commands_create",
        sandbox: SBX,
        argv: ["cat"],
        env: { TOKEN: secrets[0] },
        stdin: secrets[1],
      });
      for (const secret of secrets)
        assert.ok(!textOf(result).includes(secret), "an answer holds a secret");
    } finally {
      await client.close();
    }
  }
  assert.equal(events.length, 3);
  for (const secret of secrets)
    assert.ok(
      !JSON.stringify(events).includes(secret),
      "a log line holds a secret",
    );
});

test("a 404 not_found with another message passes through unchanged", async () => {
  const { fetch } = recording(() =>
    failure(404, "not_found", "no route for /v1/graph/summary"),
  );
  const client = await connect(fetch);
  try {
    const error = failureOf(
      await call(client, "lbb_sandboxes", { action: "retrieve", sandbox: SBX }),
    );
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "no route for /v1/graph/summary");
  } finally {
    await client.close();
  }
});

test("a one-call run takes a key of 253 characters and refuses a longer one", async () => {
  const { calls, fetch } = recording(({ input }) =>
    new URL(input).pathname === "/v1/sandboxes/commands/get"
      ? ok(command({ status: "lost", exit_code: undefined }))
      : ok(runSandbox({ status: "lost" })),
  );
  const client = await connect(fetch);
  try {
    const long = "k".repeat(254);
    const refused = failureOf(
      await call(client, "lbb_sandboxes_manage", {
        action: "run",
        code: "x",
        idempotency_key: long,
      }),
    );
    assert.match(refused.message, /254 characters.*at most 253/);
    assert.deepEqual(calls, []);
    // 253 characters: the keys of a lost run stay at 255 or fewer.
    const key = "k".repeat(253);
    await call(client, "lbb_sandboxes_manage", {
      action: "run",
      code: "x",
      idempotency_key: key,
    });
    const lengths = calls
      .map(sent)
      .filter((entry) => entry.method === "POST")
      .map((entry) => entry.key?.length);
    assert.deepEqual(lengths, [253, 255, 255]);
    // Other actions take keys up to 255.
    const longest = await call(client, "lbb_sandboxes_manage", {
      action: "create",
      idempotency_key: "k".repeat(256),
    });
    assert.equal(longest.isError, true);
  } finally {
    await client.close();
  }
});

test("an older client with no sandbox calls gives one plain error on each tool", async () => {
  const { calls, fetch } = recording(() => ok());
  const lbb = new LbbClient({
    baseUrl: "http://h",
    apiKey: "k",
    graph: "g",
    fetch,
  });
  Object.defineProperty(lbb, "sandboxes", { value: undefined });
  const server = buildLbbServer(lbb, {
    log: () => {},
    sandboxes: true,
    destructiveWithoutApproval: "refuse",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    // The server lists its tools as it always did; only the sandbox calls answer with the error.
    for (const [name, args] of [
      ["lbb_sandboxes", { action: "list" }],
      ["lbb_sandboxes_manage", { action: "run", code: "x" }],
      ["lbb_sandboxes_delete", { sandbox: SBX }],
    ] as const) {
      const error = failureOf(
        await client.callTool({ name, arguments: { ...args } }),
      );
      assert.equal(error.code, "client_too_old", name);
      assert.equal(error.message, SANDBOX_CLIENT_TOO_OLD_TEXT, name);
    }
    assert.deepEqual(calls, []);
    const lbbTools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(lbbTools.includes("lbb_query"));
  } finally {
    await client.close();
  }
});

test("the sandbox tools are registered only with LBB_MCP_SANDBOXES=1, and the option wins", async () => {
  const before = process.env.LBB_MCP_SANDBOXES;
  const listed = async (option: boolean | undefined) => {
    const client = await connectTools(async () => ok(), { sandboxes: option });
    try {
      return (await client.listTools()).tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("lbb_sandboxes"))
        .sort();
    } finally {
      await client.close();
    }
  };
  const all = ["lbb_sandboxes", "lbb_sandboxes_delete", "lbb_sandboxes_manage"];
  try {
    delete process.env.LBB_MCP_SANDBOXES;
    assert.deepEqual(await listed(undefined), []);
    for (const value of ["1", "true", " TRUE "]) {
      process.env.LBB_MCP_SANDBOXES = value;
      assert.deepEqual(await listed(undefined), all, value);
    }
    for (const value of ["0", "false", "yes", ""]) {
      process.env.LBB_MCP_SANDBOXES = value;
      assert.deepEqual(await listed(undefined), [], value);
    }
    process.env.LBB_MCP_SANDBOXES = "1";
    assert.deepEqual(await listed(false), []);
    delete process.env.LBB_MCP_SANDBOXES;
    assert.deepEqual(await listed(true), all);
  } finally {
    if (before === undefined) delete process.env.LBB_MCP_SANDBOXES;
    else process.env.LBB_MCP_SANDBOXES = before;
  }
});

test("the stdio server lists the sandbox tools only when its environment sets LBB_MCP_SANDBOXES=1", async () => {
  const script = new URL("./stdio.js", import.meta.url).pathname;
  const names = async (setting: string | undefined) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      LBB_BASE_URL: "http://127.0.0.1:1",
    };
    if (setting !== undefined) env.LBB_MCP_SANDBOXES = setting;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env,
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      return (await client.listTools()).tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("lbb_sandboxes"));
    } finally {
      await client.close();
    }
  };
  assert.deepEqual(await names(undefined), []);
  assert.equal((await names("1")).length, 3);
});
