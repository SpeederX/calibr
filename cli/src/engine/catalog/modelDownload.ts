// Node download logic for catalog models. Replaces the PowerShell
// Invoke-HFDownload: authoritative remote size+sha via @huggingface/hub, a
// `.part` staging file with real HTTP Range resume, integrity verification, and
// an atomic rename so the final path only ever holds a complete, verified file.
//
// All I/O is injected (DownloadDeps) so the decision and the orchestration are
// unit-tested deterministically without touching the network or disk. The thin
// process entrypoint (modelDownloadCli) wires the real @huggingface/hub + fetch
// + fs implementations.

export interface DownloadPlanState {
  finalExists: boolean;
  finalSize: number;
  partExists: boolean;
  partSize: number;
  /** Authoritative remote size (bytes). Must be > 0. */
  expectedSize: number;
  /** Whether the final file is recorded as calibr-downloaded (manifest). */
  calibrOwned: boolean;
}

export type DownloadPlan =
  | { kind: "skip"; reason: "complete" | "user-owned-mismatch" }
  | { kind: "resume"; fromBytes: number }
  | { kind: "restart" };

// Pure decision. Never clobbers a user-provided file: a final whose size does
// not match the remote and that calibr did not download is left untouched.
export function resolveDownloadPlan(state: DownloadPlanState): DownloadPlan {
  const { finalExists, finalSize, partExists, partSize, expectedSize, calibrOwned } = state;

  if (finalExists && finalSize === expectedSize) {
    return { kind: "skip", reason: "complete" };
  }
  if (finalExists && finalSize !== expectedSize && !calibrOwned) {
    // Present but not the exact catalog artifact, and not ours — leave it.
    return { kind: "skip", reason: "user-owned-mismatch" };
  }
  // No usable final (or a calibr-owned mismatch we may overwrite): use .part.
  if (partExists && partSize > 0 && partSize < expectedSize) {
    return { kind: "resume", fromBytes: partSize };
  }
  return { kind: "restart" };
}

export interface RemoteFileInfo {
  size: number;
  /** sha256 (LFS etag / Xet hash) when available. */
  sha: string | null;
  url: string;
}

export interface HttpGetResult {
  status: number;
  /** Full file size: Content-Range total on 206, else Content-Length. */
  total: number;
  chunks: AsyncIterable<Uint8Array>;
}

export interface DownloadFs {
  exists(path: string): boolean;
  size(path: string): number;
  ensureDir(path: string): void;
  /** Append bytes to a file, creating it if needed. */
  append(path: string, chunk: Uint8Array): void;
  truncate(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface Hasher {
  update(chunk: Uint8Array): void;
  hex(): string;
}

export interface DownloadProgress {
  bytes: number;
  total: number;
  speedMibps: number;
}

export interface DownloadDeps {
  remoteInfo(p: { repo: string; file: string; revision?: string }): Promise<RemoteFileInfo | null>;
  httpGet(url: string, opts: { rangeFrom?: number }): Promise<HttpGetResult>;
  fs: DownloadFs;
  /** Optional sha256 hasher factory; when present, a fresh download is verified. */
  hasher?: () => Hasher;
  onProgress?: (p: DownloadProgress) => void;
  now?: () => number;
}

export interface DownloadModelPayload {
  repo: string;
  file: string;
  /** Absolute final destination path. */
  destPath: string;
  calibrOwned: boolean;
  revision?: string;
}

export interface DownloadModelResult {
  ok: boolean;
  action: DownloadPlan["kind"] | "user-owned-mismatch";
  bytes: number;
  expectedBytes: number;
  sha: string | null;
  verified: boolean;
  reason?: string;
}

const PART_SUFFIX = ".part";

export async function downloadModel(
  payload: DownloadModelPayload,
  deps: DownloadDeps,
): Promise<DownloadModelResult> {
  const { repo, file, destPath, calibrOwned, revision } = payload;
  const partPath = destPath + PART_SUFFIX;
  const { fs } = deps;

  const info = await deps.remoteInfo({ repo, file, revision });
  if (!info || info.size <= 0) {
    return {
      ok: false, action: "restart", bytes: 0, expectedBytes: 0, sha: null,
      verified: false, reason: info ? "remote size unknown" : "file not found on remote",
    };
  }
  const expectedSize = info.size;

  const plan = resolveDownloadPlan({
    finalExists: fs.exists(destPath),
    finalSize: fs.exists(destPath) ? fs.size(destPath) : 0,
    partExists: fs.exists(partPath),
    partSize: fs.exists(partPath) ? fs.size(partPath) : 0,
    expectedSize,
    calibrOwned,
  });

  if (plan.kind === "skip") {
    return {
      ok: true, action: plan.reason === "complete" ? "skip" : "user-owned-mismatch",
      bytes: fs.exists(destPath) ? fs.size(destPath) : 0, expectedBytes: expectedSize,
      sha: info.sha, verified: plan.reason === "complete",
      reason: plan.reason === "user-owned-mismatch"
        ? "present with a different size than the remote; left as-is (not calibr-owned)"
        : undefined,
    };
  }

  fs.ensureDir(partPath);
  let fromBytes = 0;
  if (plan.kind === "resume") {
    fromBytes = plan.fromBytes;
  } else {
    // restart: drop any stale part
    if (fs.exists(partPath)) fs.truncate(partPath);
  }

  const resp = await deps.httpGet(info.url, fromBytes > 0 ? { rangeFrom: fromBytes } : {});
  // If we asked for a range but the server ignored it (200), restart from 0.
  if (fromBytes > 0 && resp.status !== 206) {
    fs.truncate(partPath);
    fromBytes = 0;
  }

  // sha is only meaningful over the whole file, so we hash only a from-scratch
  // download (fromBytes === 0). A resumed part can still be size-verified.
  const hasher = fromBytes === 0 && deps.hasher ? deps.hasher() : null;
  const now = deps.now ?? (() => Date.now());
  const start = now();
  let written = fromBytes;
  let lastEmit = 0;
  let lastBytes = fromBytes;

  for await (const chunk of resp.chunks) {
    fs.append(partPath, chunk);
    if (hasher) hasher.update(chunk);
    written += chunk.byteLength;
    const elapsed = now() - start;
    if (deps.onProgress && elapsed - lastEmit >= 200) {
      const speed = elapsed > lastEmit ? ((written - lastBytes) / 1048576) * 1000 / (elapsed - lastEmit) : 0;
      deps.onProgress({ bytes: written, total: expectedSize, speedMibps: speed });
      lastEmit = elapsed;
      lastBytes = written;
    }
  }
  deps.onProgress?.({ bytes: written, total: expectedSize, speedMibps: 0 });

  const finalPartSize = fs.size(partPath);
  if (finalPartSize !== expectedSize) {
    // Keep the part for a future resume; never publish a bad final file.
    return {
      ok: false, action: plan.kind, bytes: finalPartSize, expectedBytes: expectedSize,
      sha: info.sha, verified: false,
      reason: `size mismatch after download: got ${finalPartSize}, expected ${expectedSize}`,
    };
  }

  if (hasher && info.sha && hasher.hex().toLowerCase() !== info.sha.toLowerCase()) {
    fs.remove(partPath);
    return {
      ok: false, action: plan.kind, bytes: finalPartSize, expectedBytes: expectedSize,
      sha: info.sha, verified: false, reason: "sha256 mismatch after download",
    };
  }

  fs.rename(partPath, destPath);
  return {
    ok: true, action: plan.kind, bytes: expectedSize, expectedBytes: expectedSize,
    sha: info.sha, verified: hasher ? true : false,
  };
}
