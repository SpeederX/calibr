// Real (Node + Hugging Face) implementation of downloadModel's injected deps,
// shared by the download entrypoint and the intake entrypoint so the HF / fetch
// / fs / sha glue lives in one place.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileDownloadInfo } from "@huggingface/hub";
import type { DownloadDeps, DownloadProgress, HttpGetResult } from "./modelDownload.js";

// Full file size from a ranged (206 -> Content-Range "bytes a-b/total") or a
// plain (200 -> Content-Length) response.
export function totalFromHeaders(res: Response, fallback: number): number {
  const range = res.headers.get("content-range");
  const slashed = range && range.includes("/") ? Number(range.split("/")[1]) : NaN;
  if (Number.isFinite(slashed) && slashed > 0) return slashed;
  const len = Number(res.headers.get("content-length"));
  return Number.isFinite(len) && len > 0 ? len : fallback;
}

const emitDlprog = (p: DownloadProgress) =>
  process.stdout.write(`[dlprog] bytes=${p.bytes} total=${p.total} speed_mibps=${p.speedMibps.toFixed(2)}\n`);

export function realDownloadDeps(onProgress: (p: DownloadProgress) => void = emitDlprog): DownloadDeps {
  return {
    async remoteInfo({ repo, file, revision }) {
      const info = await fileDownloadInfo({ repo, path: file, revision });
      if (!info) return null;
      // The content sha256 is the (quote-wrapped) LFS etag. xet.hash is a
      // Xet-internal digest, NOT sha256(content), so it must not be used here.
      const sha = info.etag ? info.etag.replace(/"/g, "") : null;
      return { size: info.size, sha, url: info.url };
    },
    async httpGet(url, opts): Promise<HttpGetResult> {
      const headers: Record<string, string> = {};
      if (opts.rangeFrom && opts.rangeFrom > 0) headers["Range"] = `bytes=${opts.rangeFrom}-`;
      const res = await fetch(url, { headers });
      if (!res.ok && res.status !== 206) throw new Error(`download HTTP ${res.status}`);
      if (!res.body) throw new Error("download response had no body");
      const body = res.body as unknown as AsyncIterable<Uint8Array>;
      return { status: res.status, total: totalFromHeaders(res, 0), chunks: body };
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
    onProgress,
  };
}
