// Box datasets for coding agents (lbb_evals actions datasets_coco and datasets_image). A boxes dataset is images
// (files of the graph) with labelled boxes. An agent that trains or scores a detector needs the whole dataset on
// disk, which does not fit an MCP answer: datasets_coco answers a summary, the COCO file itself when it fits, and
// the commands that write the dataset with its images to a folder. datasets_image shows one image with its boxes.
import type { LbbClient, Schemas } from "@littlebigbrain/client";
import { HARD_OUTPUT_CHARS } from "./tool-contracts.js";

type Coco = Schemas["EvalCocoExport"];
type Dataset = Schemas["EvalDataset"];

/** Images of the summary shown with their boxes. */
const SAMPLE_IMAGES = 3;
/** The whole COCO file goes into the answer up to this many characters. */
const COCO_INLINE_CHARS = HARD_OUTPUT_CHARS / 2;
/** An image larger than this is not sent as MCP image content. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** How to fetch a dataset whole, with the client's endpoint and graph filled in. */
export function fetchCommands(
  id: string,
  graph: string | undefined,
  baseUrl: string | undefined,
) {
  const query = `${graph ? `graph=${encodeURIComponent(graph)}&` : ""}id=${encodeURIComponent(id)}`;
  const base = baseUrl ?? "$LBB_BASE_URL";
  const folder = `data/${id}`;
  return {
    http: `GET /v1/evals/datasets/coco?${query}`,
    curl: `curl -fsS -H "Authorization: Bearer $LBB_API_KEY" "${base}/v1/evals/datasets/coco?${query}" -o ${folder}.coco.json`,
    image: `GET /v1/files/content?${graph ? `graph=${encodeURIComponent(graph)}&` : ""}sha256=<images[n].lbb_file>`,
    python: [
      "import os",
      "from lbb import LbbClient",
      `client = LbbClient(os.environ["LBB_BASE_URL"], api_key=os.environ["LBB_API_KEY"]${graph ? `, graph=${JSON.stringify(graph)}` : ""})`,
      `client.evals.datasets.download(${JSON.stringify(id)}, ${JSON.stringify(folder)}, only_done=True)`,
      `# ${folder}/annotations.json (COCO), ${folder}/items.jsonl, ${folder}/images/`,
    ].join("\n"),
  };
}

/** The summary of a COCO export: counts per label and status, a few images with their boxes, and the file when it fits. */
export function cocoSummary(
  coco: Coco,
  fetch: ReturnType<typeof fetchCommands>,
): Record<string, unknown> {
  const labels = new Map(
    coco.categories.map((category) => [category.id, category.name]),
  );
  const boxes: Record<string, number> = Object.fromEntries(
    coco.categories.map((category) => [category.name, 0]),
  );
  let ignoreRegions = 0;
  let uncertain = 0;
  for (const a of coco.annotations) {
    if (a.iscrowd) ignoreRegions += 1;
    else {
      const name = labels.get(a.category_id) ?? String(a.category_id);
      boxes[name] = (boxes[name] ?? 0) + 1;
      if (a.lbb_uncertain) uncertain += 1;
    }
  }
  const status: Record<string, number> = { done: 0, todo: 0, skipped: 0 };
  for (const image of coco.images)
    status[image.lbb_status] = (status[image.lbb_status] ?? 0) + 1;
  const sample = coco.images.slice(0, SAMPLE_IMAGES).map((image) => ({
    file_name: image.file_name,
    width: image.width,
    height: image.height,
    lbb_file: image.lbb_file,
    lbb_status: image.lbb_status,
    boxes: coco.annotations
      .filter((a) => a.image_id === image.id && !a.iscrowd)
      .map((a) => ({
        label: labels.get(a.category_id),
        box: [
          a.bbox[0],
          a.bbox[1],
          a.bbox[0] + a.bbox[2],
          a.bbox[1] + a.bbox[3],
        ],
      })),
  }));
  const text = JSON.stringify(coco);
  const inline = text.length <= COCO_INLINE_CHARS;
  return {
    dataset: coco.info,
    images: { total: coco.images.length, ...status },
    boxes,
    uncertain_boxes: uncertain,
    ignore_regions: ignoreRegions,
    sample,
    ...(inline
      ? { coco }
      : {
          coco_omitted: `The COCO file has ${text.length} characters, more than one answer holds. Fetch it with one of fetch.`,
        }),
    fetch,
    note: "bbox in COCO is [x, y, width, height] in pixels; boxes here are [x0, y0, x1, y1]. Score and train on lbb_status done images only. iscrowd 1 is an ignore region: a found box inside it is neither a hit nor a false positive.",
  };
}

/** The media type of image bytes from their first bytes; null for no known image. */
export function imageType(bytes: Uint8Array): string | null {
  const at = (n: number, ...values: number[]) =>
    values.every((v, k) => bytes[n + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  return null;
}

/** One item of a boxes dataset as an MCP answer: its boxes as text, then the image when it is small enough. */
export async function itemImage(client: LbbClient, id: string, name: string) {
  const dataset: Dataset = await client.evals.datasets.get(id);
  if (dataset.kind !== "boxes")
    throw new Error(`datasets_image reads a boxes dataset; ${id} holds values`);
  const item = (dataset.items ?? []).find(
    (candidate) => candidate.name === name,
  );
  if (!item)
    throw new Error(
      `the dataset ${id} has no item ${JSON.stringify(name)}; datasets_coco lists the file_name of each image`,
    );
  if (!item.file)
    throw new Error(`the item ${JSON.stringify(name)} names no file`);
  const bytes = await client.files.content(item.file);
  const type = imageType(bytes);
  const value = {
    dataset: id,
    item: item.name,
    file: item.file,
    width: item.width,
    height: item.height,
    status: item.status ?? "done",
    labels: item.labels ?? dataset.install?.labels ?? [],
    boxes: item.boxes ?? [],
    ignore: item.ignore ?? [],
    ...(type && bytes.byteLength <= IMAGE_MAX_BYTES
      ? {}
      : {
          image_omitted: type
            ? `the image has ${bytes.byteLength} bytes, more than ${IMAGE_MAX_BYTES}`
            : "the file is not a PNG, JPEG, GIF or WebP image",
        }),
  };
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [{ type: "text", text: JSON.stringify(value, null, 2) }];
  if (type && bytes.byteLength <= IMAGE_MAX_BYTES)
    content.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: type,
    });
  return { content, structuredContent: value };
}
