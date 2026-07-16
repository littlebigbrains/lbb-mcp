import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpHttpServer,
  type McpHttpServerOptions,
} from "./http-server.js";

type Response = { status: number; body: string };
const TEST_BASE_URL = "https://0abc1def--research.db.eu.littlebigbrain.com";

async function listeningServer(options: Partial<McpHttpServerOptions> = {}) {
  const server = createMcpHttpServer({ baseUrl: TEST_BASE_URL, ...options });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    call: (
      path: string,
      init: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      } = {},
    ) =>
      new Promise<Response>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: init.method ?? "GET",
            headers: { connection: "close", ...init.headers },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end(init.body);
      }),
  };
}

async function close(
  server: ReturnType<typeof createMcpHttpServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("HTTP edge validates configuration before listening", () => {
  assert.throws(
    () => createMcpHttpServer({ baseUrl: "" }),
    /baseUrl is required/,
  );
  let caught: unknown;
  try {
    createMcpHttpServer({ baseUrl: TEST_BASE_URL, mcpPath: "mcp" });
  } catch (error) {
    caught = error;
  }
  assert.match(String(caught), /mcpPath must start with/);
  let invalidSize = false;
  try {
    createMcpHttpServer({ baseUrl: TEST_BASE_URL, maxBodyBytes: 0 });
  } catch {
    invalidSize = true;
  }
  assert.equal(invalidSize, true);
});

test("HTTP edge exposes health and rejects invalid requests precisely", async () => {
  const { server, call } = await listeningServer({ maxBodyBytes: 16 });
  try {
    const health = await call("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    assert.equal((await call("/elsewhere")).status, 404);
    assert.equal((await call("/mcp", { method: "POST" })).status, 401);
    assert.equal(
      (
        await call("/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer secret",
            "content-type": "text/plain",
          },
          body: "{}",
        })
      ).status,
      415,
    );

    const invalid = await call("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: "not-json",
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body), {
      error: "invalid JSON request body",
    });

    const oversized = await call("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "this body is deliberately too large" }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(JSON.parse(oversized.body), {
      error: "request body too large",
    });
  } finally {
    await close(server);
  }
});

test("HTTP edge redacts unexpected internal errors", async () => {
  const observed: unknown[] = [];
  let clientOptions: unknown;
  const { server, call } = await listeningServer({
    onError: (error) => observed.push(error),
    clientFactory: (options) => {
      clientOptions = options;
      throw new Error("secret upstream configuration");
    },
  });
  try {
    const response = await call("/mcp?graph=research&branch=review", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), {
      error: "internal server error",
    });
    assert.equal(
      response.body.includes("secret upstream configuration"),
      false,
    );
    assert.equal(observed.length, 1);
    assert.deepEqual(clientOptions, {
      baseUrl: TEST_BASE_URL,
      apiKey: "secret",
      graph: "research",
      branch: "review",
    });
  } finally {
    await close(server);
  }
});

test("HTTP edge enforces DNS-rebinding protection when allowedHosts is set", async () => {
  const { server, call } = await listeningServer({
    allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"],
  });
  try {
    const base = {
      method: "POST",
      body: "{}",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
    };

    const rebound = await call("/mcp", {
      ...base,
      headers: { ...base.headers, host: "attacker.example:8080" },
    });
    assert.equal(rebound.status, 403);
    assert.deepEqual(JSON.parse(rebound.body), {
      error: "forbidden host header",
    });

    const badOrigin = await call("/mcp", {
      ...base,
      headers: { ...base.headers, origin: "https://attacker.example" },
    });
    assert.equal(badOrigin.status, 403);
    assert.deepEqual(JSON.parse(badOrigin.body), { error: "forbidden origin" });

    // Loopback host + loopback origin pass the check (401 only without a
    // token; with one, the request proceeds past the guard).
    const loopbackOrigin = await call("/mcp", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:8080",
      },
    });
    assert.equal(loopbackOrigin.status, 401);

    // /healthz stays reachable for probes regardless of Host.
    const health = await call("/healthz", {
      headers: { host: "10.0.0.7:8080" },
    });
    assert.equal(health.status, 200);
  } finally {
    await close(server);
  }
});

test("HTTP edge allows exact extra origins via allowedOrigins", async () => {
  const { server, call } = await listeningServer({
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["https://console.example.com"],
  });
  try {
    const allowed = await call("/mcp", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "https://console.example.com",
      },
    });
    // Passes the rebinding guard; fails auth because no bearer was sent.
    assert.equal(allowed.status, 401);
  } finally {
    await close(server);
  }
});
