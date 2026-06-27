// Process entrypoint spawned by engine/catalog.ps1 (Invoke-HFDownload) to fetch
// one catalog model. Reads a JSON payload via --json-file, runs downloadModel
// with the real Node + Hugging Face deps, streams the file with resume, and
// emits the [phase]/[dlprog]/[dldone] markers the Ink RunView parses. Prints a
// final JSON result line and exits 0/1.

import { readFile } from "node:fs/promises";
import { downloadModel, type DownloadModelPayload, type DownloadModelResult } from "./modelDownload.js";
import { realDownloadDeps } from "./nodeDownloadDeps.js";

function fail(reason: string): DownloadModelResult {
  return { ok: false, action: "restart", bytes: 0, expectedBytes: 0, sha: null, verified: false, reason };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--json-file");
  const path = idx >= 0 ? argv[idx + 1] ?? "" : "";
  let result: DownloadModelResult;
  try {
    if (!path) throw new Error("usage: modelDownloadCli --json-file <path>");
    const payload = JSON.parse(await readFile(path, "utf8")) as DownloadModelPayload;
    process.stdout.write("[phase] downloading\n");
    result = await downloadModel(payload, realDownloadDeps());
    if (result.ok && result.action !== "skip" && result.action !== "user-owned-mismatch") {
      process.stdout.write(`[dldone] bytes=${result.bytes}\n`);
    }
  } catch (error) {
    result = fail(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

await main();
