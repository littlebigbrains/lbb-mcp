import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, ok, type Call } from "./test-support.js";
import { cocoSummary, fetchCommands, imageType } from "./eval-boxes-tool.js";

const SHA = "a".repeat(64);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

const COCO = {
  info: {
    dataset: "ds_1",
    name: "plans",
    created: "2026-11-27T10:00:00.000000Z",
  },
  images: [
    {
      id: 1,
      file_name: "plan-1",
      width: 100,
      height: 80,
      lbb_file: SHA,
      lbb_status: "done",
    },
    {
      id: 2,
      file_name: "plan-2",
      width: 100,
      height: 80,
      lbb_file: SHA,
      lbb_status: "todo",
    },
  ],
  annotations: [
    {
      id: 1,
      image_id: 1,
      category_id: 2,
      bbox: [20, 0, 20, 4],
      area: 80,
      iscrowd: 0,
      lbb_uncertain: true,
    },
    {
      id: 2,
      image_id: 1,
      category_id: 1,
      bbox: [70, 70, 10, 10],
      area: 100,
      iscrowd: 1,
    },
    {
      id: 3,
      image_id: 2,
      category_id: 1,
      bbox: [1, 1, 4, 4],
      area: 16,
      iscrowd: 0,
    },
  ],
  categories: [
    { id: 1, name: "door" },
    { id: 2, name: "window" },
  ],
};

const DATASET = {
  id: "ds_1",
  object: "eval_dataset",
  created: "2026-11-27T10:00:00.000000Z",
  name: "plans",
  kind: "boxes",
  install: { properties: {}, labels: ["door", "window"] },
  item_count: 1,
  items: [
    {
      name: "plan-1",
      file: SHA,
      width: 100,
      height: 80,
      values: [],
      leave_out: [],
      boxes: [{ label: "window", box: [20, 0, 40, 4] }],
    },
  ],
};

async function setup() {
  const calls: Call[] = [];
  const client = await connect(async (input, init) => {
    calls.push({ input, init: init ?? {} });
    const url = new URL(input);
    if (url.pathname === "/v1/evals/datasets/coco") return ok(COCO);
    if (url.pathname === "/v1/evals/datasets/get") return ok(DATASET);
    if (url.pathname === "/v1/files/content")
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => PNG.buffer.slice(0),
      };
    return {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: { type: "not_found", code: "not_found", message: "no" },
        }),
    };
  });
  return { client, calls };
}

test("datasets_coco answers counts, a sample and the COCO file, and how to fetch it whole", async () => {
  const { client, calls } = await setup();
  try {
    const result = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_coco", id: "ds_1" },
    });
    assert.equal(result.isError, undefined);
    const url = new URL(calls.at(-1)!.input);
    assert.equal(url.pathname, "/v1/evals/datasets/coco");
    assert.equal(url.searchParams.get("id"), "ds_1");
    assert.equal(url.searchParams.get("graph"), "g");
    const text = (result.content as { text: string }[])[0]!.text;
    const body = JSON.parse(text) as { data: Record<string, unknown> };
    const data = body.data;
    assert.deepEqual(data.images, { total: 2, done: 1, todo: 1, skipped: 0 });
    assert.deepEqual(data.boxes, { door: 1, window: 1 });
    assert.equal(data.ignore_regions, 1);
    assert.equal(data.uncertain_boxes, 1);
    assert.deepEqual((data.sample as { boxes: unknown[] }[])[0]!.boxes, [
      { label: "window", box: [20, 0, 40, 4] },
    ]);
    assert.deepEqual(data.coco, COCO);
    const fetch = data.fetch as Record<string, string>;
    assert.match(
      fetch.python!,
      /client\.evals\.datasets\.download\("ds_1", "data\/ds_1", only_done=True\)/,
    );
    assert.match(fetch.python!, /graph="g"/);
    assert.match(fetch.curl!, /\/v1\/evals\/datasets\/coco\?graph=g&id=ds_1/);
  } finally {
    await client.close();
  }
});

test("a COCO file too large for one answer is left out, with the way to fetch it", () => {
  const many = {
    ...COCO,
    annotations: Array.from({ length: 2_000 }, (_, n) => ({
      id: n + 1,
      image_id: 1,
      category_id: 1,
      bbox: [1, 1, 4, 4],
      area: 16,
      iscrowd: 0,
    })),
  };
  const summary = cocoSummary(
    many as never,
    fetchCommands("ds_1", undefined, "https://db.example"),
  );
  assert.equal(summary.coco, undefined);
  assert.match(String(summary.coco_omitted), /more than one answer holds/);
  assert.deepEqual(summary.boxes, { door: 2_000, window: 0 });
  assert.match(
    (summary.fetch as { curl: string }).curl,
    /^curl .*"https:\/\/db\.example\/v1\/evals\/datasets\/coco\?id=ds_1"/,
  );
});

test("datasets_image shows one image with its boxes", async () => {
  const { client } = await setup();
  try {
    const result = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_image", id: "ds_1", item: "plan-1" },
    });
    const content = result.content as (
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    )[];
    assert.equal(content.length, 2);
    const head = JSON.parse((content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    assert.equal(head.item, "plan-1");
    assert.deepEqual(head.boxes, [{ label: "window", box: [20, 0, 40, 4] }]);
    assert.deepEqual(content[1], {
      type: "image",
      data: Buffer.from(PNG).toString("base64"),
      mimeType: "image/png",
    });

    const missing = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_image", id: "ds_1", item: "plan-9" },
    });
    assert.equal(missing.isError, true);
    const error = JSON.parse(
      (missing.content as { text: string }[])[0]!.text,
    ) as { error: { message: string } };
    assert.match(error.error.message, /no item "plan-9"/);
    const noItem = await client.callTool({
      name: "lbb_evals",
      arguments: { action: "datasets_image", id: "ds_1" },
    });
    assert.equal(noItem.isError, true);
  } finally {
    await client.close();
  }
});

test("imageType reads the signature of the common image formats", () => {
  assert.equal(imageType(PNG), "image/png");
  assert.equal(
    imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assert.equal(
    imageType(
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
    ),
    "image/webp",
  );
  assert.equal(imageType(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null);
});
