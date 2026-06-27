// Per-model intake in TS — the lean replacement for the per-entry
// Invoke-Discover + Invoke-Plan re-run in catalog mode. For one catalog entry it
// composes: ensure the file is present (download when missing), read the local
// GGUF header, verify its signature against the remote header (always-on
// anti-tampering), and assemble the model metadata record that the planner
// consumes. All I/O is injected so the logic is unit-tested without disk or
// network.

import {
  compareGgufSignature,
  isUnreadableGguf,
  type GgufBlockTensorBytes,
  type GgufHeaderMetadata,
} from "../discover/ggufMetadata.js";

// ---- filename identity (ports discover.ps1 Get-ModelMetadata parsing) -------

export interface ModelIdentity {
  model: string;
  series: string;
  variant: string;
  params_b: number;
  is_moe_heuristic: boolean;
}

const VARIANT_PATTERNS: RegExp[] = [
  /^(.+?)[.\-](UD-Q\d+_K_XL)$/,
  /^(.+?)[.\-](UD-Q\d+_K_M)$/,
  /^(.+?)[.\-](UD-Q\d+_K_S)$/,
  /^(.+?)[.\-](Q\d+_K_[A-Z]+)$/,
  /^(.+?)[.\-](Q\d+_\d+)$/,
  /^(.+?)[.\-](IQ\d+_[A-Z0-9_-]+)$/,
  /^(.+?)[.\-](BF16|F16|F32|MXFP4)$/i,
];

// baseName = file name without the .gguf extension (shard handling is the
// PowerShell discover's job for now; intake targets single-file catalog models).
export function parseModelIdentity(baseName: string): ModelIdentity {
  let model = baseName;
  let variant = "unknown";
  for (const re of VARIANT_PATTERNS) {
    const m = re.exec(baseName);
    if (m) { model = m[1]; variant = m[2]; break; }
  }
  let series = model;
  const seriesMatch = /^(.+?)-[A-Z]?\d+(\.\d+)?B(-A\d+B)?(-it|-Instruct)?$/.exec(model);
  if (seriesMatch) series = seriesMatch[1];

  const is_moe_heuristic = /A\d+B/.test(model) || /MoE/.test(model) || /Mixtral/.test(model);
  const paramMatch = /(\d+\.?\d*)B/.exec(model);
  const params_b = paramMatch ? Number(paramMatch[1]) : 0;

  return { model, series, variant, params_b, is_moe_heuristic };
}

// ---- model metadata record (catalog.json entry the planner reads) ----------

export interface ModelMetadata {
  role: "model";
  path: string;
  name: string;
  size_bytes: number;
  size_mib: number;
  shard_count: number;
  shard_paths: string[];
  model: string;
  series: string;
  variant: string;
  params_b: number;
  is_moe: boolean;
  mmproj: string | null;
  dir: string;
  gguf_architecture: string | null;
  gguf_context_length: number | null;
  gguf_block_count: number | null;
  gguf_tensor_count: number;
  gguf_tensor_data_offset: number | null;
  gguf_tensor_bytes: number | null;
  gguf_global_tensor_bytes: number | null;
  gguf_expert_tensor_bytes: number | null;
  gguf_block_tensor_bytes: GgufBlockTensorBytes[];
  reasoning_mode: string | null;
  template_note: string | null;
}

export interface CatalogEntryInput {
  hf_repo: string;
  hf_file: string;
  target_dir: string;
  reasoning_mode?: string | null;
  template_note?: string | null;
}

export interface IntakeFs {
  exists(path: string): boolean;
  sizeBytes(path: string): number;
  /** Sibling mmproj-*.gguf in dir, already preference-ordered (F16 < BF16 < F32). */
  pickMmproj(dir: string): string | null;
  join(...parts: string[]): string;
  baseName(path: string): string;   // file name with extension
  dirName(path: string): string;
  stripGgufExt(name: string): string;
}

export function buildModelMetadata(
  path: string,
  header: GgufHeaderMetadata,
  entry: CatalogEntryInput,
  fs: IntakeFs,
): ModelMetadata {
  const name = fs.baseName(path);
  const dir = fs.dirName(path);
  const id = parseModelIdentity(fs.stripGgufExt(name));
  const sizeBytes = fs.sizeBytes(path);
  return {
    role: "model",
    path,
    name,
    size_bytes: sizeBytes,
    size_mib: Math.trunc(sizeBytes / (1024 * 1024)),
    shard_count: 1,
    shard_paths: [path],
    model: id.model,
    series: id.series,
    variant: id.variant,
    params_b: id.params_b,
    is_moe: id.is_moe_heuristic || (header.expert_tensor_bytes ?? 0) > 0,
    mmproj: fs.pickMmproj(dir),
    dir,
    gguf_architecture: header.architecture,
    gguf_context_length: header.context_length,
    gguf_block_count: header.block_count,
    gguf_tensor_count: header.tensor_count,
    gguf_tensor_data_offset: header.tensor_data_offset,
    gguf_tensor_bytes: header.tensor_bytes,
    gguf_global_tensor_bytes: header.global_tensor_bytes,
    gguf_expert_tensor_bytes: header.expert_tensor_bytes,
    gguf_block_tensor_bytes: header.block_tensor_bytes,
    reasoning_mode: entry.reasoning_mode ?? null,
    template_note: entry.template_note ?? null,
  };
}

// ---- orchestration ----------------------------------------------------------

export type IntakeErrorKind = "download_failed" | "unreadable_gguf" | "signature_mismatch";

export interface IntakeResult {
  ok: boolean;
  metadata?: ModelMetadata;
  errorKind?: IntakeErrorKind;
  error?: string;
  /** Set when the remote header could not be read (offline): signature unverified. */
  signatureUnverified?: boolean;
}

export interface IntakeDeps {
  /** Download the file when missing; resolves ok=false with a reason on failure. */
  ensurePresent(path: string, entry: CatalogEntryInput): Promise<{ ok: boolean; reason?: string }>;
  readLocalHeader(path: string): Promise<GgufHeaderMetadata>;
  /** Remote header (range, no full download); null when unavailable (offline). */
  readRemoteHeader(entry: CatalogEntryInput): Promise<GgufHeaderMetadata | null>;
  fs: IntakeFs;
  onWarn?: (message: string) => void;
}

export interface IntakePayload {
  entry: CatalogEntryInput;
  /** Root that contains target_dir (scan_paths[0] or -Destination). */
  destRoot: string;
}

export async function intakeModel(payload: IntakePayload, deps: IntakeDeps): Promise<IntakeResult> {
  const { entry, destRoot } = payload;
  const { fs } = deps;
  const path = fs.join(destRoot, entry.target_dir, entry.hf_file);

  if (!fs.exists(path)) {
    const dl = await deps.ensurePresent(path, entry);
    if (!dl.ok) return { ok: false, errorKind: "download_failed", error: dl.reason ?? "download failed" };
  }

  const local = await deps.readLocalHeader(path);
  if (isUnreadableGguf(local)) {
    return { ok: false, errorKind: "unreadable_gguf", error: `not a readable GGUF: ${path}` };
  }

  let signatureUnverified = false;
  const remote = await deps.readRemoteHeader(entry);
  if (remote) {
    const cmp = compareGgufSignature(local, remote);
    if (!cmp.match) {
      const diffs = cmp.diffs.map((d) => `${String(d.field)}: local=${d.local} remote=${d.remote}`).join("; ");
      return { ok: false, errorKind: "signature_mismatch", error: `GGUF signature mismatch for ${path} (${diffs})` };
    }
  } else {
    signatureUnverified = true;
    deps.onWarn?.(`could not read remote header for ${entry.hf_repo}/${entry.hf_file}; signature left unverified`);
  }

  return { ok: true, metadata: buildModelMetadata(path, local, entry, fs), signatureUnverified };
}
