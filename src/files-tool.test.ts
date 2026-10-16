import { test } from "node:test";
import assert from "node:assert/strict";
import type { FetchLike, Schemas } from "@littlebigbrain/client";
import {
  FILE_LINES_BUDGET,
  FILE_LINE_CHARS,
  fileLineText,
  pageLines,
} from "./files-tool.js";
import { connect, ok, payload, type Call } from "./test-support.js";

const SHA = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function line(page: number, n: number, text: string): Schemas["FileLine"] {
  return {
    id: `p${page + 1}-l${n}`,
    text,
    box: [0.1, n / 100, 0.5, n / 100 + 0.01],
    words: [],
  };
}

function page(index: number, texts: string[]): Schemas["FilePage"] {
  return {
    page: index,
    width: 595.22,
    height: 842,
    lines: texts.map((text, at) => line(index, at + 1, text)),
  };
}

const FILES = {
  files: [
    {
      sha256: SHA,
      name: "room-book.pdf",
      content_type: "application/pdf",
      bytes: 1024,
      uploaded_at: "2026-10-10T08:00:00Z",
      document: "https://littlebigbrain.com/e/0123456789abcdef0123456789abcdef",
      parse: {
        status: "parsed",
        page_count: 3,
        parsed_at: "2026-10-10T08:01:00Z",
      },
    },
    {
      sha256: OTHER,
      name: "equipment.pdf",
      content_type: "application/pdf",
      bytes: 2048,
      uploaded_at: "2026-10-10T08:00:00Z",
      document: "https://littlebigbrain.com/e/fedcba9876543210fedcba9876543210",
    },
  ],
};

test("a line reads as its id, its box and its text, cut when long", () => {
  assert.equal(
    fileLineText(line(0, 3, "S 1.1 Washbasin")),
    "p1-l3 [0.1,0.03,0.5,0.04] S 1.1 Washbasin",
  );
  const long = fileLineText(line(0, 1, "x".repeat(FILE_LINE_CHARS + 50)));
  assert.ok(long.endsWith("…"));
  assert.ok(long.length < FILE_LINE_CHARS + 30);
});

test("page lines stop at the cap and name where the next call starts", () => {
  const pages = [page(1, ["a", "b", "c"]), page(2, ["d", "e"])];
  const first = pageLines(pages, { lineOffset: 0, maxLines: 4 });
  assert.equal(first.shown, 4);
  assert.deepEqual(
    first.pages.map((entry) => entry.lines.length),
    [3, 1],
  );
  assert.deepEqual(first.next, { from: 2, line_offset: 1 });
  const rest = pageLines([pages[1]], { lineOffset: 1, maxLines: 4 });
  assert.equal(rest.shown, 1);
  assert.match(rest.pages[0].lines[0], /^p3-l2 /);
  assert.equal(rest.next, undefined);
});

test("page lines keep the lines that hold a text, and the character budget", () => {
  const pages = [page(0, ["Room S 1.1", "Door T30", "see s 1.1 above"])];
  const found = pageLines(pages, {
    lineOffset: 0,
    maxLines: 10,
    contains: "S 1.1",
  });
  assert.equal(found.shown, 2);
  assert.equal(found.pages[0].lines_total, 3);
  assert.equal(found.pages[0].lines_matching, 2);
  const many = Array.from({ length: 1_000 }, () => "y".repeat(300));
  const capped = pageLines([page(0, many)], { lineOffset: 0, maxLines: 1_000 });
  const chars = capped.pages[0].lines.join("").length;
  assert.ok(chars <= FILE_LINES_BUDGET, `${chars} characters`);
  assert.ok(capped.shown < 1_000);
  assert.deepEqual(capped.next, { from: 0, line_offset: capped.shown });
});

test("lbb_files lists the files and reads a page by sha256 or by name", async () => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/files/pages"))
      return ok({
        sha256: SHA,
        parser: "poppler-26.03.0",
        page_count: 3,
        from: 1,
        to: 2,
        pages: [page(1, ["S 1.1 Washbasin", "W 60 cm"])],
      });
    // The first page names the next one; the page after it is the last.
    return ok(input.includes("after=c1") ? FILES : { ...FILES, next: "c1" });
  };
  const client = await connect(fetch);
  try {
    const listed = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: { action: "list", graph: "docs", detail: "full" },
      }),
    );
    assert.equal(
      (listed.data as { files: Array<{ name: string }> }).files[1].name,
      "equipment.pdf",
    );
    assert.match(
      calls.at(-1)?.input ?? "",
      /\/v1\/files\?graph=docs&limit=50$/,
    );
    assert.deepEqual(listed.next, { action: "list", after: "c1" });
    const second = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: { action: "list", graph: "docs", after: "c1" },
      }),
    );
    assert.match(
      calls.at(-1)?.input ?? "",
      /\/v1\/files\?graph=docs&limit=50&after=c1$/,
    );
    assert.equal(second.next, undefined);

    const bySha = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: { action: "pages", sha256: SHA.toUpperCase(), from: 1 },
      }),
    );
    assert.match(
      calls.at(-1)?.input ?? "",
      new RegExp(`/v1/files/pages\\?graph=g&sha256=${SHA}&from=1&to=2$`),
    );
    const data = bySha.data as {
      line_format: string;
      pages: Array<{ page: number; lines: string[] }>;
    };
    assert.equal(data.line_format, "<line id> [x0,y0,x1,y1] <text>");
    assert.deepEqual(data.pages[0].lines, [
      "p2-l1 [0.1,0.01,0.5,0.02] S 1.1 Washbasin",
      "p2-l2 [0.1,0.02,0.5,0.03] W 60 cm",
    ]);
    assert.equal(bySha.next, undefined);

    const before = calls.length;
    const byName = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: {
          action: "pages",
          name: "room-book.pdf",
          from: 1,
          max_lines: 1,
        },
      }),
    );
    assert.equal(
      calls.length,
      before + 2,
      "a name reads the list filtered by it first",
    );
    assert.match(
      calls[before].input,
      /\/v1\/files\?graph=g&limit=1000&name=room-book\.pdf$/,
    );
    assert.match(byName.summary, /^room-book\.pdf, page 1 of 3/);
    assert.deepEqual(byName.next, {
      action: "pages",
      sha256: SHA,
      from: 1,
      to: 2,
      line_offset: 1,
    });
  } finally {
    await client.close();
  }
});

test("lbb_files refuses a call that names no file it can read", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    return ok(FILES);
  });
  try {
    for (const args of [
      { action: "pages" },
      { action: "pages", sha256: "abc" },
      { action: "pages", name: "missing.pdf" },
      { action: "pages", sha256: SHA, from: 2, to: 2 },
    ]) {
      const result = await client.callTool({
        name: "lbb_files",
        arguments: args,
      });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.ok(
      calls.every((call) => !call.input.includes("/v1/files/pages")),
      "no page read",
    );
    // The missing name lists the graph's files in its error.
    const missing = await client.callTool({
      name: "lbb_files",
      arguments: { action: "pages", name: "missing.pdf" },
    });
    assert.match(JSON.stringify(missing.content), /room-book\.pdf/);
  } finally {
    await client.close();
  }
});

test("lbb_files filters the list and its next repeats the filters", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const failed = { files: [FILES.files[0]], as_of_commit_seq: 42 };
    return ok(input.includes("after=") ? failed : { ...failed, next: "m1" });
  });
  try {
    const listed = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: {
          action: "list",
          parse_status: "failed",
          name: "Room Book",
          detail: "full",
        },
      }),
    );
    assert.match(
      calls.at(-1)?.input ?? "",
      /\/v1\/files\?graph=g&limit=50&parse_status=failed&name=Room%20Book$/,
    );
    const data = listed.data as {
      files: Array<{ name: string }>;
      as_of_commit_seq: number;
    };
    assert.equal(data.files[0].name, "room-book.pdf");
    assert.equal(data.as_of_commit_seq, 42);
    // The server binds the cursor to the filters: next names them again.
    assert.deepEqual(listed.next, {
      action: "list",
      parse_status: "failed",
      name: "Room Book",
      after: "m1",
    });
    const second = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: listed.next as Record<string, unknown>,
      }),
    );
    assert.match(
      calls.at(-1)?.input ?? "",
      /\/v1\/files\?graph=g&limit=50&after=m1&parse_status=failed&name=Room%20Book$/,
    );
    assert.equal(second.next, undefined);

    // The plain list names no commit; a status the server has no name for
    // is refused before a call.
    const before = calls.length;
    const refused = await client.callTool({
      name: "lbb_files",
      arguments: { action: "list", parse_status: "done" },
    });
    assert.equal(refused.isError, true);
    assert.equal(calls.length, before);
  } finally {
    await client.close();
  }
});

test("lbb_files pages finds a file by name beyond the newest files", async () => {
  const calls: Call[] = [];
  const older = {
    ...FILES.files[0],
    sha256: OTHER,
    name: "room-book-2019.pdf",
  };
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/files/pages"))
      return ok({
        sha256: OTHER,
        parser: "poppler-26.03.0",
        page_count: 1,
        from: 0,
        to: 1,
        pages: [page(0, ["S 1.1 Washbasin"])],
      });
    // The filter finds the older file, and a name that holds it.
    if (input.includes("name="))
      return ok({
        files: [{ ...older, name: "room-book-2019.pdf.bak" }, older],
        as_of_commit_seq: 7,
      });
    return ok(FILES);
  });
  try {
    const found = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: { action: "pages", name: "room-book-2019.pdf" },
      }),
    );
    assert.match(found.summary, /^room-book-2019\.pdf, page 0 of 1/);
    assert.deepEqual(
      calls.map((call) => call.input.replace(/^http:\/\/h/, "")),
      [
        "/v1/files?graph=g&limit=1000&name=room-book-2019.pdf",
        `/v1/files/pages?graph=g&sha256=${OTHER}&from=0&to=1`,
      ],
    );
  } finally {
    await client.close();
  }
});

test("lbb_files pages finds a new upload the published generation lacks", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    if (input.includes("/v1/files/pages"))
      return ok({
        sha256: SHA,
        parser: "poppler-26.03.0",
        page_count: 3,
        from: 0,
        to: 1,
        pages: [page(0, ["S 1.1 Washbasin"])],
      });
    // The filtered list reads the published generation: it lacks the file.
    if (input.includes("name=")) return ok({ files: [], as_of_commit_seq: 3 });
    return ok(FILES);
  });
  try {
    const found = payload(
      await client.callTool({
        name: "lbb_files",
        arguments: { action: "pages", name: "room-book.pdf" },
      }),
    );
    assert.match(found.summary, /^room-book\.pdf, page 0 of 3/);
    assert.deepEqual(
      calls.map((call) => call.input.replace(/^http:\/\/h/, "")),
      [
        "/v1/files?graph=g&limit=1000&name=room-book.pdf",
        "/v1/files?graph=g&limit=50",
        `/v1/files/pages?graph=g&sha256=${SHA}&from=0&to=1`,
      ],
    );
  } finally {
    await client.close();
  }
});

test("lbb_files pages refuses a name that several files have", async () => {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const twin = { ...FILES.files[1], name: "room-book.pdf" };
    return ok({ files: [FILES.files[0], twin], as_of_commit_seq: 3 });
  });
  try {
    const result = await client.callTool({
      name: "lbb_files",
      arguments: { action: "pages", name: "room-book.pdf" },
    });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.match(text, /several files are named room-book\.pdf/);
    assert.match(text, new RegExp(`${SHA}, ${OTHER}`));
    assert.equal(calls.length, 1, "the filtered list found both");
  } finally {
    await client.close();
  }
});
