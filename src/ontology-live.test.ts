import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LbbClient } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";
import { payload } from "./test-support.js";

// Opt in after `cargo build -p lbb-server`: this starts its own isolated local
// server and never accepts a hosted URL or credentials.
test(
  "MCP creates, reasons over and extends a real ontology; rejects unsupported deletion",
  {
    skip: !process.env.LBB_TEST_SERVER_BIN,
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lbb-ontology-mcp-"));
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const processHandle = spawn(
      process.env.LBB_TEST_SERVER_BIN!,
      [
        "--root",
        root,
        "--tenant",
        "test",
        "--graph",
        "main",
        "--bind",
        `127.0.0.1:${address.port}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    processHandle.stderr.on("data", (data: Buffer) => {
      logs += data.toString();
    });
    processHandle.stdout.on("data", (data: Buffer) => {
      logs += data.toString();
    });
    let launchError: Error | undefined;
    processHandle.on("error", (error) => {
      launchError = error;
    });
    const server = buildLbbServer(
      new LbbClient({ baseUrl, graph: "main", retryDelayMs: 20 }),
    );
    const client = new Client({ name: "ontology-live-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: {
          graph: "main",
          ...args,
          ...(name === "lbb_configure" ? {} : { detail: "full" }),
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return payload(result).data as Record<string, unknown>;
    };
    try {
      let healthy = false;
      for (let i = 0; i < 150; i++) {
        if (launchError) throw launchError;
        if (processHandle.exitCode !== null) throw new Error(logs);
        healthy = await fetch(`${baseUrl}/healthz`)
          .then((r) => r.ok)
          .catch(() => false);
        if (healthy) break;
        await delay(200);
      }
      assert.ok(healthy, logs);
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await call("lbb_configure", {
        action: "define_ontology",
        entity_types: ["Agent", { name: "Person", super_types: ["Agent"] }],
        relations: ["KNOWS"],
      });
      const native = await call("lbb_inspect", { action: "ontology" });
      assert.ok(
        (native.entity_type_defs as { super_types: string[] }[]).some((d) =>
          d.super_types.includes("agent"),
        ),
      );
      await call("lbb_configure", {
        action: "evolve_ontology",
        ops: [
          { op: "add_entity_type", name: "Contact" },
          {
            op: "add_super_types",
            entity_type: "Person",
            super_types: ["Contact"],
          },
        ],
      });
      const evolved = await call("lbb_inspect", { action: "ontology" });
      assert.ok(
        (evolved.entity_type_defs as { super_types: string[] }[]).some((d) =>
          d.super_types.includes("contact"),
        ),
      );
      const source = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:Person> a owl:Class ; rdfs:subClassOf <urn:Agent> ; rdfs:comment "An explicit ontology annotation" .
<urn:employs> owl:inverseOf <urn:worksFor> .
<urn:ada> a <urn:Person> ; <urn:worksFor> <urn:acme> .`;
      await call("lbb_rdf", {
        action: "import",
        source,
      });
      const ask = async (query: string, entailment: string) => {
        for (let i = 0; i < 200; i++) {
          const result = await client.callTool({
            name: "lbb_query",
            arguments: {
              mode: "sparql",
              query,
              entailment,
              consistency: "strong",
              detail: "full",
            },
          });
          if (!result.isError)
            return (payload(result).data as { boolean: boolean }).boolean;
          if (
            !/strong_read_pending|published.*unavailable|publication_pending/.test(
              JSON.stringify(result),
            )
          )
            assert.fail(JSON.stringify(result));
          await delay(200);
        }
        assert.fail(
          `publication did not settle: ${JSON.stringify(await call("lbb_inspect", { action: "publication" }))}\n${logs}`,
        );
      };
      assert.equal(
        await ask(
          'ASK { <urn:Person> <http://www.w3.org/2000/01/rdf-schema#comment> "An explicit ontology annotation" }',
          "none",
        ),
        true,
      );
      assert.equal(await ask("ASK { <urn:ada> a <urn:Agent> }", "none"), false);
      assert.equal(await ask("ASK { <urn:ada> a <urn:Agent> }", "owl"), true);
      assert.equal(
        await ask("ASK { <urn:acme> <urn:employs> <urn:ada> }", "owl"),
        true,
      );
      await call("lbb_rdf", {
        action: "update",
        update: `INSERT DATA { <urn:Person> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:Contact> }`,
      });
      assert.equal(await ask("ASK { <urn:ada> a <urn:Agent> }", "owl"), true);
      assert.equal(await ask("ASK { <urn:ada> a <urn:Contact> }", "owl"), true);
      const rejected = await client.callTool({
        name: "lbb_rdf",
        arguments: {
          action: "update",
          update:
            "DELETE DATA { <urn:Person> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <urn:Agent> }",
        },
      });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /only INSERT DATA is supported/);
      assert.equal(await ask("ASK { <urn:ada> a <urn:Agent> }", "owl"), true);
    } finally {
      await client.close();
      await server.close();
      if (processHandle.exitCode === null && processHandle.pid) {
        const ended = new Promise<void>((resolve) =>
          processHandle.once("exit", () => resolve()),
        );
        processHandle.kill("SIGINT");
        await ended;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
