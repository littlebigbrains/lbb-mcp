import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LbbClient, type FetchLike } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";

export type Call = {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
};

export async function connect(fetch: FetchLike): Promise<Client> {
  const lbb = new LbbClient({
    baseUrl: "http://h",
    apiKey: "k",
    graph: "g",
    fetch,
    retryDelayMs: 0,
  });
  const server = buildLbbServer(lbb);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

export function ok(value: unknown = {}): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  };
}

export function payload(result: Awaited<ReturnType<Client["callTool"]>>): {
  summary: string;
  data: unknown;
  counts?: Record<string, number>;
  row_page?: {
    returned: number;
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
    next_offset?: number | null;
  };
  truncated?: boolean;
  rows_shown?: number;
  next?: Record<string, unknown>;
} {
  return JSON.parse(
    (result.content as { type: string; text: string }[])[0].text,
  );
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
