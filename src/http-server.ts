import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LbbClient } from "@littlebigbrain/client";
import { buildLbbServer } from "./server.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface McpHttpServerOptions {
  /** Required Little Big Brain stack endpoint (`endpoint_url` from Connect). */
  baseUrl: string;
  mcpPath?: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  /**
   * DNS-rebinding protection for the MCP route. When set, the request `Host`
   * hostname must be in the list, and a present `Origin` hostname must be in
   * it too (or the exact origin in `allowedOrigins`); otherwise 403. Leave
   * unset only when the server sits behind an edge that already pins Host
   * (the hosted OAuth endpoint does). The `lbb-mcp-http` entrypoint defaults
   * this to loopback names when bound to loopback.
   */
  allowedHosts?: string[];
  /** Exact `Origin` values additionally allowed by the rebinding check. */
  allowedOrigins?: string[];
  onError?: (error: unknown) => void;
  clientFactory?: (options: {
    baseUrl: string;
    apiKey: string;
    graph?: string;
    branch?: string;
  }) => LbbClient;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(value));
}

function headerHostname(value: string): string | undefined {
  try {
    // `Host` has no scheme and `Origin` does; parse each accordingly.
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function rebindingProblem(
  req: IncomingMessage,
  allowedHosts: string[],
  allowedOrigins: string[],
): HttpProblem | undefined {
  const host = req.headers.host;
  const hostName = typeof host === "string" ? headerHostname(host) : undefined;
  if (!hostName || !allowedHosts.includes(hostName)) {
    return new HttpProblem(403, "forbidden host header");
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    const originName = headerHostname(origin);
    const originAllowed =
      allowedOrigins.includes(origin) ||
      (originName !== undefined && allowedHosts.includes(originName));
    if (!originAllowed) return new HttpProblem(403, "forbidden origin");
  }
  return undefined;
}

export function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = auth.slice(7).trim();
  return token || undefined;
}

export function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    req.resume();
    return Promise.reject(new HttpProblem(413, "request body too large"));
  }

  return new Promise((resolve, reject) => {
    let bytes = 0;
    let data = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBodyBytes) {
        tooLarge = true;
        data = "";
      } else if (!tooLarge) {
        data += chunk;
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new HttpProblem(413, "request body too large"));
        return;
      }
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpProblem(400, "invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Build the key-bearer streamable-HTTP MCP edge without starting a listener.
 * The hosted multi-tenant OAuth endpoint remains in the SaaS API.
 */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const baseUrl = options.baseUrl.trim();
  const mcpPath = options.mcpPath ?? "/mcp";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const allowedHosts = options.allowedHosts;
  const allowedOrigins = options.allowedOrigins ?? [];
  if (!baseUrl) {
    throw new Error(
      "baseUrl is required; copy endpoint_url from the stack's Connect page",
    );
  }
  if (!mcpPath.startsWith("/")) throw new Error("mcpPath must start with /");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive integer");
  }

  return createServer(
    { requestTimeout: requestTimeoutMs },
    async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/healthz") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || url.pathname !== mcpPath) {
          req.resume();
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (allowedHosts && allowedHosts.length > 0) {
          const problem = rebindingProblem(req, allowedHosts, allowedOrigins);
          if (problem) {
            req.resume();
            sendJson(res, problem.status, { error: problem.message });
            return;
          }
        }
        const apiKey = bearer(req);
        if (!apiKey) {
          req.resume();
          sendJson(res, 401, { error: "missing bearer token" });
          return;
        }
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          req.resume();
          sendJson(res, 415, {
            error: "content-type must be application/json",
          });
          return;
        }
        const body = await readJsonBody(req, maxBodyBytes);

        const clientOptions = {
          baseUrl,
          apiKey,
          graph: url.searchParams.get("graph") ?? undefined,
          branch: url.searchParams.get("branch") ?? undefined,
        };
        const client = options.clientFactory
          ? options.clientFactory(clientOptions)
          : new LbbClient(clientOptions);
        const server = buildLbbServer(client);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        options.onError?.(error);
        if (!res.headersSent) {
          if (error instanceof HttpProblem) {
            sendJson(res, error.status, { error: error.message });
          } else {
            sendJson(res, 500, { error: "internal server error" });
          }
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
    },
  );
}
