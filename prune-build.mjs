import { rm } from "node:fs/promises";

await Promise.all(
  [
    "dist/http.d.ts",
    "dist/stdio.d.ts",
    "dist/tool-contracts.d.ts",
    "dist/tool-runtime.d.ts",
  ].map((path) => rm(new URL(path, import.meta.url), { force: true })),
);
