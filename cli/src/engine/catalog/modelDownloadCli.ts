// Process entrypoint spawned by engine/catalog.ps1 (Invoke-HFDownload) to fetch
// one catalog model. Reads a JSON payload via --json-file, wires the real
// @huggingface/hub + Node fetch + fs + sha256 into downloadModel, streams the
// file with resume, and emits the [phase]/[dlprog]/[dldone] markers the Ink
// RunView already parses. Prints a final JSON result line and exits 0/1.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileDownloadInfo } from "@huggingface/hub";
import {
  downloadModel,
  type DownloadDeps,
  type DownloadModelPayload,
  type DownloadModelResult,
  type HttpGetResult,
} from "./modelDownload.js";

function fail(reason: string): DownloadModelResult {
  return { ok: false, action: "restart", bytes: 0, expectedBytes: 0, sha: null, verified: false, reason };
}

// Full file size from a ranged (206 -> Content-Range "bytes a-b/total") or a
// plain (200 -> Content-Length) response.
function totalFromHeaders(res: Response, fallback: number): number {
  const range = res.headers.get("content-range");
  const slashed = range && range.includes("/") ? Number(range.split("/")[1]) : NaN;
  if (Number.isFinite(slashed) && slashed > 0) return slashed;
  const len = Number(res.headers.get("content-length"));
  return Number.isFinite(len) && len > 0 ? len : fallback;
}

function realDeps(expectedHint: number): DownloadDeps {
  return {
    async remoteInfo({ repo, file, revision }) {
      const info = await fileDownloadInfo({ repo, path: file, revision });
      if (!info) return null;
      const sha = info.xet?.hash ?? info.etag ?? null;
      return { size: info.size, sha: sha ? sha.replace(/"/g, "") : null, url: info.url };
    },
    async httpGet(url, opts): Promise<HttpGetResult> {
      const headers: Record<string, string> = {};
      if (opts.rangeFrom && opts.rangeFrom > 0) headers["Range"] = `bytes=${opts.rangeFrom}-`;
      const res = await fetch(url, { headers });
      if (!res.ok && res.status !== 206) throw new Error(`download HTTP ${res.status}`);
      if (!res.body) throw new Error("download response had no body");
      const body = res.body as unknown as AsyncIterable<Uint8Array>;
      return { status: res.status, total: totalFromHeaders(res, expectedHint), chunks: body };
    },
    fs: {
      exists: (p) => existsSync(p),
      size: (p) => statSync(p).size,
      ensureDir: (p) => mkdirSync(dirname(p), { recursive: true }),
      append: (p, chunk) => appendFileSync(p, chunk),
      truncate: (p) => writeFileSync(p, new Uint8Array(0)),
      rename: (from, to) => renameSync(from, to),
      remove: (p) => rmSync(p, { force: true }),
    },
    hasher: () => {
      const h = createHash("sha256");
      return { update: (chunk) => { h.update(chunk); }, hex: () => h.digest("hex") };
    },
    onProgress: ({ bytes, total, speedMibps }) => {
      process.stdout.write(`[dlprog] bytes=${bytes} total=${total} speed_mibps=${speedMibps.toFixed(2)}\n`);
    },
  };
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
    result = await downloadModel(payload, realDeps(0));
    if (result.ok && (result.action === "skip" || result.action === "user-owned-mismatch")) {
      // nothing streamed
    } else if (result.ok) {
      process.stdout.write(`[dldone] bytes=${result.bytes}\n`);
    }
  } catch (error) {
    result = fail(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

await main();
