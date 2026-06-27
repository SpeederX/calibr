// Process entrypoint spawned by engine/discover.ps1 to read local GGUF header
// metadata via @huggingface/gguf. Two modes:
//   --path <file>        -> one file; prints that file's header metadata
//   --paths-file <json>  -> JSON array or { paths: [...] }; prints { "<path>": metadata, ... }
// Always valid JSON (readGgufHeaderMetadata returns empties on error).

import { readFile } from "node:fs/promises";
import { readGgufHeaderMetadata, type GgufHeaderMetadata } from "./ggufMetadata.js";

function parseJsonFile(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function normalizePathsPayload(payload: unknown): string[] {
  const wrapped = typeof payload === "object" && payload !== null
    ? (payload as { paths?: unknown }).paths
    : undefined;
  const value = Array.isArray(payload)
    ? payload
    : Array.isArray(wrapped)
      ? wrapped
      : typeof wrapped === "string"
        ? [wrapped]
      : typeof payload === "string"
        ? [payload]
        : [];
  return value.filter((p): p is string => typeof p === "string" && p.length > 0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const pathsFileIdx = argv.indexOf("--paths-file");
  if (pathsFileIdx >= 0) {
    const file = argv[pathsFileIdx + 1] ?? "";
    if (!file) {
      process.stdout.write(`${JSON.stringify({ error: "usage: ggufMetadataCli --paths-file <json>" })}\n`);
      process.exitCode = 2;
      return;
    }
    const paths = normalizePathsPayload(parseJsonFile(await readFile(file, "utf8")));
    const out: Record<string, GgufHeaderMetadata> = {};
    for (const p of paths) out[p] = await readGgufHeaderMetadata(p);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  const idx = argv.indexOf("--path");
  const path = idx >= 0 ? argv[idx + 1] ?? "" : "";
  if (!path) {
    process.stdout.write(`${JSON.stringify({ error: "usage: ggufMetadataCli --path <file> | --paths-file <json>" })}\n`);
    process.exitCode = 2;
    return;
  }
  const metadata = await readGgufHeaderMetadata(path);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 2;
}
