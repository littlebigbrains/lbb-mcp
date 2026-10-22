import type { ToolHost } from "./approval.js";
import type { LbbClient, Schemas } from "@littlebigbrain/client";
import { z } from "zod";
import { READ_ONLY, detailSchema, graphScope } from "./tool-contracts.js";
import {
  enrichError,
  errorResult,
  run,
  scoped,
  toolResult,
} from "./tool-runtime.js";

/** Files one `list` call returns: one page, newest upload first. */
export const FILES_PER_LIST = 50;
/**
 * Files `pages` reads to find a name: one page of the list filtered by the
 * name, the most one page holds.
 */
export const FILES_PER_NAME_LOOKUP = 1_000;
/** The parse statuses `list` filters by; `waiting` is a file without one. */
export const FILE_PARSE_STATUSES = [
  "parsed",
  "waiting",
  "unsupported",
  "failed",
] as const;
/** Lines one `pages` call returns by default, and at most. */
export const FILE_LINES_DEFAULT = 200;
export const FILE_LINES_MAX = 1_000;
/** Characters of one line's text a call shows; a longer text is cut with "…". */
export const FILE_LINE_CHARS = 400;
/** Characters of lines one call returns at most, so the result fits an MCP answer. */
export const FILE_LINES_BUDGET = 60_000;

type FilePage = Schemas["FilePage"];

/** One line as the tool shows it: `<id> [x0,y0,x1,y1] <text>`. */
export function fileLineText(line: Schemas["FileLine"]): string {
  const text =
    line.text.length > FILE_LINE_CHARS
      ? `${line.text.slice(0, FILE_LINE_CHARS - 1)}…`
      : line.text;
  return `${line.id} [${line.box.join(",")}] ${text}`;
}

export interface PageLinesWindow {
  /** Lines of the first page to skip (they were shown by the call before). */
  lineOffset: number;
  maxLines: number;
  /** Only lines whose text holds this, ignoring case. */
  contains?: string;
}

export interface PageLinesAnswer {
  pages: Array<{
    page: number;
    width: number;
    height: number;
    lines_total: number;
    lines_matching: number;
    lines: string[];
  }>;
  shown: number;
  /** Where the next call starts when lines were left out. */
  next?: { from: number; line_offset: number };
}

/**
 * The lines of parsed pages as short strings, at most `maxLines` and
 * {@link FILE_LINES_BUDGET} characters, from `lineOffset` of the first page.
 * `next` names the page and the offset of the first line left out.
 */
export function pageLines(
  pages: FilePage[],
  window: PageLinesWindow,
): PageLinesAnswer {
  const needle = window.contains?.trim().toLowerCase();
  const answer: PageLinesAnswer = { pages: [], shown: 0 };
  let budget = FILE_LINES_BUDGET;
  for (const [index, page] of pages.entries()) {
    const skip = index === 0 ? window.lineOffset : 0;
    const shown: string[] = [];
    let matching = 0;
    let stoppedAt: number | undefined;
    for (const [position, line] of page.lines.entries()) {
      if (position < skip) continue;
      if (needle && !line.text.toLowerCase().includes(needle)) continue;
      matching += 1;
      if (stoppedAt !== undefined) continue;
      const text = fileLineText(line);
      if (answer.shown >= window.maxLines || text.length > budget) {
        stoppedAt = position;
        continue;
      }
      shown.push(text);
      answer.shown += 1;
      budget -= text.length;
    }
    answer.pages.push({
      page: page.page,
      width: page.width,
      height: page.height,
      lines_total: page.lines.length,
      lines_matching: matching,
      lines: shown,
    });
    if (stoppedAt !== undefined) {
      answer.next = { from: page.page, line_offset: stoppedAt };
      break;
    }
  }
  return answer;
}

const SHA256 = /^[0-9a-fA-F]{64}$/;

/** The files of `files` named `name` exactly (both composed, NFC). */
function namedExactly(
  files: Schemas["FileRecord"][],
  name: string,
): Schemas["FileRecord"][] {
  const wanted = name.normalize("NFC");
  return files.filter((file) => file.name.normalize("NFC") === wanted);
}

/**
 * The SHA-256 of the file a call names, by `sha256` or by its exact name.
 * A name is looked up in the list filtered by it, which finds a file of any
 * age; that list reads the published generation, so a file uploaded since
 * is looked up in the newest files of the plain list.
 */
async function fileSha(
  target: LbbClient,
  args: { sha256?: string; name?: string },
): Promise<{ sha256: string; name?: string }> {
  if (args.sha256) {
    if (!SHA256.test(args.sha256.trim()))
      throw new Error("sha256 is 64 hexadecimal characters");
    return { sha256: args.sha256.trim().toLowerCase() };
  }
  if (!args.name) throw new Error("pages needs sha256 or name");
  const filtered = await target.files.list({
    name: args.name,
    limit: FILES_PER_NAME_LOOKUP,
  });
  let files = filtered.files;
  let named = namedExactly(files, args.name);
  if (named.length === 0) {
    ({ files } = await target.files.list({ limit: FILES_PER_LIST }));
    named = namedExactly(files, args.name);
  }
  if (named.length === 1)
    return { sha256: named[0].sha256, name: named[0].name };
  if (named.length > 1)
    throw new Error(
      `several files are named ${args.name}; pass sha256: ${named.map((file) => file.sha256).join(", ")}`,
    );
  const names = files.slice(0, 20).map((file) => file.name);
  throw new Error(
    `no file is named ${args.name}${names.length ? `; the graph has ${names.join(", ")}` : "; the graph has no files"}`,
  );
}

export function registerFilesTool(host: ToolHost, client: LbbClient): void {
  host.register(
    "lbb_files",
    {
      description:
        "Files of the graph, read only. A file is a document the graph holds (its bytes and a Document entity); the documents.parse workflow (lbb_workflows) reads the text layer of each PDF into pages with every line and its box. list shows 50 files a call, newest upload first, with their sha256, name, size, Document IRI and parse (status parsed, unsupported or failed, page_count); when more follow, next names the after of the next call (with the same filters). parse_status keeps the files of one parse status; waiting is a file not parsed yet. name keeps the files whose name holds a text, in any case. A filtered list reads the Documents of the published generation and names its commit (as_of_commit_seq). A file uploaded, renamed or parsed a moment ago can be missing from it until publication. pages reads parsed pages of one file (sha256, or name for an exact file name): from is the first 0-based page index (the page of a region and of a DocEntry or DocMention), to the page after the last one (default from+1). Each line comes as `<line id> [x0,y0,x1,y1] <text>`: the id is p<page number>-l<line number>, both from 1, and the box is normalized to the page (0 to 1, origin top left). contains keeps the lines that hold a text; max_lines caps the lines (default 200). When lines were left out, next names the from and line_offset of the next call. A file not parsed yet answers file_not_parsed.",
      inputSchema: {
        action: z.enum(["list", "pages"]),
        after: z
          .string()
          .optional()
          .describe(
            "list: the next 50 files, from a previous call's next (pass the same parse_status and name).",
          ),
        parse_status: z
          .enum(FILE_PARSE_STATUSES)
          .optional()
          .describe(
            "list: only the files of this parse status; waiting is a file not parsed yet.",
          ),
        sha256: z
          .string()
          .optional()
          .describe("pages: the file's SHA-256 (64 hex characters)."),
        name: z
          .string()
          .optional()
          .describe(
            "list: only the files whose name holds this text, in any case. pages: the file's exact name, when you do not have its sha256.",
          ),
        from: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("pages: the first page index, 0-based. Default 0."),
        to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "pages: the page index after the last one. Default from+1; at most 50 pages per call.",
          ),
        line_offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "pages: lines of the first page to skip, from a previous call's next.",
          ),
        max_lines: z
          .number()
          .int()
          .positive()
          .max(FILE_LINES_MAX)
          .optional()
          .describe(
            `pages: the most lines to return. Default ${FILE_LINES_DEFAULT}.`,
          ),
        contains: z
          .string()
          .optional()
          .describe(
            "pages: only the lines whose text holds this, ignoring case.",
          ),
        detail: detailSchema,
        ...graphScope,
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const target = scoped(client, args.graph);
      if (args.action === "list") {
        // The server binds a cursor to its filters: the next call repeats them.
        const filters = {
          ...(args.parse_status ? { parse_status: args.parse_status } : {}),
          ...(args.name ? { name: args.name } : {}),
        };
        let next: string | undefined;
        return run(
          client,
          "lbb_files.list",
          args.detail,
          async () => {
            const page = await target.files.list({
              limit: FILES_PER_LIST,
              ...(args.after ? { after: args.after } : {}),
              ...(args.parse_status ? { parseStatus: args.parse_status } : {}),
              ...(args.name ? { name: args.name } : {}),
            });
            next = page.next ?? undefined;
            return {
              files: page.files,
              ...(page.as_of_commit_seq != null
                ? { as_of_commit_seq: page.as_of_commit_seq }
                : {}),
            };
          },
          () =>
            next
              ? {
                  truncated: true,
                  next: { action: "list", ...filters, after: next },
                }
              : {},
        );
      }
      try {
        const file = await fileSha(target, args);
        const from = args.from ?? 0;
        const to = args.to ?? from + 1;
        if (to <= from) throw new Error("to must be above from");
        const answer = await target.files.pages(file.sha256, { from, to });
        const lines = pageLines(answer.pages, {
          lineOffset: args.line_offset ?? 0,
          maxLines: args.max_lines ?? FILE_LINES_DEFAULT,
          contains: args.contains,
        });
        const label = file.name ?? answer.sha256.slice(0, 12);
        const range =
          answer.to - answer.from > 1
            ? `pages ${answer.from} to ${answer.to - 1}`
            : `page ${answer.from}`;
        return toolResult({
          summary: `${label}, ${range} of ${answer.page_count} (0-based): ${lines.shown} lines${lines.next ? ", more after next" : ""}`,
          data: {
            sha256: answer.sha256,
            parser: answer.parser,
            page_count: answer.page_count,
            from: answer.from,
            to: answer.to,
            line_format: "<line id> [x0,y0,x1,y1] <text>",
            pages: lines.pages,
          },
          ...(lines.next
            ? {
                truncated: true,
                next: {
                  action: "pages",
                  sha256: answer.sha256,
                  from: lines.next.from,
                  to: answer.to,
                  line_offset: lines.next.line_offset,
                  ...(args.contains ? { contains: args.contains } : {}),
                },
              }
            : {}),
        });
      } catch (error) {
        return errorResult(await enrichError(client, error));
      }
    },
  );
}
