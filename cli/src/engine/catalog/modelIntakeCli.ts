// Process entrypoint spawned by the engine workflow for the lean catalog intake.
// Two modes (--mode), payload via --json-file:
//   plan    -> { entries[], destRoot }            : upfront pre-pass summary
//   intake  -> { entry, destRoot, calibrOwned?, telemetry? } : per-model intake
// Prints a single JSON result line. The remote GGUF signature check runs only
// when telemetry is requested; the default is the local light cache match.

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileDownloadInfo } from "@huggingface/hub";
import { downloadModel } from "./modelDownload.js";
import { realDownloadDeps } from "./nodeDownloadDeps.js";
import {
  intakeModel,
  planCatalogIntake,
  type CatalogEntryInput,
  type IntakeDeps,
  type IntakeFs,
} from "./modelIntake.js";
import { readGgufHeaderMetadata, readGgufHeaderMetadataRemote } from "../discover/ggufMetadata.js";

function pickMmproj(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => /^mmproj-.*\.gguf$/i.test(f));
    if (!files.length) return null;
    const rank = (n: string) => (/BF16/i.test(n) ? 1 : /F32/i.test(n) ? 2 : /F16/i.test(n) ? 0 : 3);
    files.sort((a, b) => rank(a) - rank(b));
    return join(dir, files[0]);
  } catch {
    return null;
  }
}

const realFs: IntakeFs = {
  exists: (p) => existsSync(p),
  sizeBytes: (p) => statSync(p).size,
  pickMmproj,
  join: (...parts) => join(...parts),
  baseName: (p) => basename(p),
  dirName: (p) => dirname(p),
  stripGgufExt: (n) => n.replace(/\.gguf$/i, ""),
};

function realIntakeDeps(calibrOwned: boolean, telemetry: boolean): IntakeDeps {
  return {
    fs: realFs,
    async ensurePresent(path, entry) {
      process.stdout.write("[phase] downloading\n");
      const result = await downloadModel(
        { repo: entry.hf_repo, file: entry.hf_file, destPath: path, calibrOwned },
        realDownloadDeps(),
      );
      if (result.ok) process.stdout.write(`[dldone] bytes=${result.bytes}\n`);
      return { ok: result.ok, reason: result.reason };
    },
    readLocalHeader: (path) => readGgufHeaderMetadata(path),
    async readRemoteHeader(entry) {
      if (!telemetry) return null; // default: no network; signature is telemetry-only
      try {
        const info = await fileDownloadInfo({ repo: entry.hf_repo, path: entry.hf_file });
        if (!info) return null;
        return await readGgufHeaderMetadataRemote(info.url, info.size);
      } catch {
        return null;
      }
    },
    onWarn: (message) => process.stdout.write(`[warn] ${message}\n`),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv[argv.indexOf("--mode") + 1] ?? "";
  const file = argv[argv.indexOf("--json-file") + 1] ?? "";
  try {
    if (!file) throw new Error("usage: modelIntakeCli --mode plan|intake --json-file <path>");
    const payload = JSON.parse(await readFile(file, "utf8"));

    if (mode === "plan") {
      const entries = (payload.entries ?? []) as CatalogEntryInput[];
      const summary = planCatalogIntake(entries, String(payload.destRoot ?? ""), realFs);
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return;
    }
    if (mode === "intake") {
      const result = await intakeModel(
        { entry: payload.entry as CatalogEntryInput, destRoot: String(payload.destRoot ?? "") },
        realIntakeDeps(Boolean(payload.calibrOwned), Boolean(payload.telemetry)),
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    throw new Error(`unknown --mode '${mode}' (expected plan|intake)`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 2;
  }
}

await main();
