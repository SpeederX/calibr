// Process entrypoint spawned by engine/discover.ps1 (Get-GgufHeaderMetadata) to
// read one local GGUF's header metadata via @huggingface/gguf. Prints a single
// JSON line; always valid JSON (readGgufHeaderMetadata returns empties on error).

import { readGgufHeaderMetadata } from "./ggufMetadata.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--path");
  const path = idx >= 0 ? argv[idx + 1] ?? "" : "";
  if (!path) {
    process.stdout.write(`${JSON.stringify({ error: "usage: ggufMetadataCli --path <file>" })}\n`);
    process.exitCode = 2;
    return;
  }
  const metadata = await readGgufHeaderMetadata(path);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

await main();
