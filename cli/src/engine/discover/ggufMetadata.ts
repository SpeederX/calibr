// GGUF header metadata via @huggingface/gguf. Reproduces, field-for-field, the
// hand-rolled parser in engine/discover.ps1 (Get-GgufHeaderMetadata): the same
// offset-delta tensor sizing and the same global / expert / per-block byte
// split that the offload + MoE planners depend on. Keeping the math identical
// is the whole point, so the byte computation is a pure function cross-validated
// against the PowerShell parser on real GGUFs.

import { gguf } from "@huggingface/gguf";
import { statSync } from "node:fs";

export interface GgufBlockTensorBytes {
  block: number;
  bytes: number;
  expert_bytes: number;
}

export interface GgufHeaderMetadata {
  architecture: string | null;
  context_length: number | null;
  block_count: number | null;
  tensor_count: number;
  tensor_data_offset: number | null;
  tensor_bytes: number | null;
  global_tensor_bytes: number | null;
  expert_tensor_bytes: number | null;
  block_tensor_bytes: GgufBlockTensorBytes[];
}

export interface ParsedGguf {
  metadata: Record<string, unknown>;
  tensorInfos: Array<{ name: string; offset: bigint | number }>;
  tensorDataOffset: bigint | number;
}

const EMPTY: GgufHeaderMetadata = {
  architecture: null, context_length: null, block_count: null, tensor_count: 0,
  tensor_data_offset: null, tensor_bytes: null, global_tensor_bytes: null,
  expert_tensor_bytes: null, block_tensor_bytes: [],
};

// PS matched any metadata key ending in `.context_length` / `.block_count`,
// not a fixed architecture prefix; mirror that.
function findBySuffix(md: Record<string, unknown>, suffix: string): unknown {
  for (const [k, v] of Object.entries(md)) {
    if (k.endsWith(suffix)) return v;
  }
  return undefined;
}

function toNum(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

const BLOCK_RE = /(?:^|\.)blk\.(\d+)(?:\.|$)/;
const EXPERT_RE = /ffn.*_exps|experts?/;

export function computeGgufHeaderMetadata(parsed: ParsedGguf, fileSize: number): GgufHeaderMetadata {
  const md = parsed.metadata ?? {};
  const out: GgufHeaderMetadata = {
    ...EMPTY,
    architecture: typeof md["general.architecture"] === "string" ? (md["general.architecture"] as string) : null,
    context_length: toNum(findBySuffix(md, ".context_length")),
    block_count: toNum(findBySuffix(md, ".block_count")),
    tensor_count: parsed.tensorInfos.length,
    block_tensor_bytes: [],
  };

  const dataStart = Number(parsed.tensorDataOffset);
  if (!Number.isFinite(dataStart) || dataStart > fileSize) return out;
  out.tensor_data_offset = dataStart;

  const ordered = parsed.tensorInfos
    .map((t) => ({ name: t.name, offset: Number(t.offset) }))
    .sort((a, b) => a.offset - b.offset);

  const blockBytes = new Map<number, number>();
  const blockExpertBytes = new Map<number, number>();
  let globalBytes = 0;
  let expertBytes = 0;
  let tensorBytes = 0;

  for (let i = 0; i < ordered.length; i++) {
    const start = dataStart + ordered[i].offset;
    const end = i + 1 < ordered.length ? dataStart + ordered[i + 1].offset : fileSize;
    if (start < dataStart || end < start || end > fileSize) continue;
    const bytes = end - start;
    tensorBytes += bytes;

    const blockMatch = BLOCK_RE.exec(ordered[i].name);
    const blockIndex = blockMatch ? Number(blockMatch[1]) : null;
    const isExpert = EXPERT_RE.test(ordered[i].name);
    if (blockIndex !== null) {
      blockBytes.set(blockIndex, (blockBytes.get(blockIndex) ?? 0) + bytes);
      if (isExpert) blockExpertBytes.set(blockIndex, (blockExpertBytes.get(blockIndex) ?? 0) + bytes);
    } else {
      globalBytes += bytes;
    }
    if (isExpert) expertBytes += bytes;
  }

  out.tensor_bytes = tensorBytes;
  out.global_tensor_bytes = globalBytes;
  out.expert_tensor_bytes = expertBytes;
  out.block_tensor_bytes = [...blockBytes.keys()].sort((a, b) => a - b).map((block) => ({
    block,
    bytes: blockBytes.get(block) ?? 0,
    expert_bytes: blockExpertBytes.get(block) ?? 0,
  }));
  return out;
}

export async function readGgufHeaderMetadata(path: string): Promise<GgufHeaderMetadata> {
  try {
    const parsed = await gguf(path, { allowLocalFile: true });
    return computeGgufHeaderMetadata(parsed as ParsedGguf, statSync(path).size);
  } catch {
    return { ...EMPTY };
  }
}

// Reads a GGUF header straight from a remote URL (range requests, no full
// download), then sizes tensors against the authoritative remote byte length.
export async function readGgufHeaderMetadataRemote(
  url: string,
  remoteSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GgufHeaderMetadata> {
  const parsed = await gguf(url, { fetch: fetchImpl });
  return computeGgufHeaderMetadata(parsed as ParsedGguf, remoteSize);
}

export interface GgufSignatureDiff {
  field: keyof GgufHeaderMetadata;
  local: unknown;
  remote: unknown;
}

// True when a local file IS the catalog's model: its GGUF fingerprint matches
// the remote one. Used as an always-on anti-tampering check (e.g. a renamed
// model can't masquerade as another). Per-block byte arrays are summarised by
// their scalar aggregates, which already pin the architecture + quantisation.
export function compareGgufSignature(
  local: GgufHeaderMetadata,
  remote: GgufHeaderMetadata,
): { match: boolean; diffs: GgufSignatureDiff[] } {
  const fields: Array<keyof GgufHeaderMetadata> = [
    "architecture", "block_count", "context_length", "tensor_count",
    "tensor_bytes", "global_tensor_bytes", "expert_tensor_bytes",
  ];
  const diffs: GgufSignatureDiff[] = [];
  for (const field of fields) {
    if (local[field] !== remote[field]) diffs.push({ field, local: local[field], remote: remote[field] });
  }
  return { match: diffs.length === 0, diffs };
}

// A GGUF whose header could not be read at all (e.g. truncated/not really GGUF).
export function isUnreadableGguf(md: GgufHeaderMetadata): boolean {
  return md.architecture === null && md.tensor_count === 0 && md.tensor_bytes === null;
}
