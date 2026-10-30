import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LbbClient, type FetchLike } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";
import type { LbbServerOptions } from "./query-observer.js";

export type Call = {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
};

/** A test client that shows forms: it answers each elicitation request. */
export type Elicit = (
  params: ElicitRequest["params"],
) => ElicitResult | Promise<ElicitResult>;

/**
 * A server on a fake fetch, and a client. With `elicit` the client shows
 * forms (`elicitation` names its modes otherwise, for example `{ url: {} }`
 * for a client that only opens links). The server's log is silent and it
 * refuses destructive calls it cannot ask about, unless `options` say else.
 */
export async function connect(
  fetch: FetchLike,
  options?: LbbServerOptions,
  elicit?: Elicit,
  elicitation: Record<string, object> = {},
  clientOptions: { maxRetries?: number } = {},
): Promise<Client> {
  const lbb = new LbbClient({
    ...clientOptions,
    baseUrl: "http://h",
    apiKey: "k",
    graph: "g",
    fetch,
    retryDelayMs: 0,
  });
  const server = buildLbbServer(lbb, {
    log: () => {},
    destructiveWithoutApproval: "refuse",
    ...options,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "0" },
    elicit ? { capabilities: { elicitation } } : undefined,
  );
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, (request) =>
      elicit(request.params),
    );
  }
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

/** One request the fake fetch saw, parsed. */
export type Sent = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  key: string | undefined;
};

/** The method, path, query, JSON body and idempotency key of one request. */
export function sent(call: Call): Sent {
  const url = new URL(call.input);
  return {
    method: call.init.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body: call.init.body === undefined ? undefined : JSON.parse(call.init.body),
    key: call.init.headers?.["idempotency-key"],
  };
}
