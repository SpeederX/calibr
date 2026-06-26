export interface GgufBlockTensorBytes {
  block: number;
  bytes: number;
  expert_bytes?: number | null;
}

export interface GgufWeightMetadata {
  size_mib: number;
  gguf_block_count?: number | null;
  gguf_tensor_bytes?: number | null;
  gguf_global_tensor_bytes?: number | null;
  gguf_block_tensor_bytes?: GgufBlockTensorBytes[] | null;
}

export interface InitialOffloadEstimateOptions {
  availableMib: number;
  runtimeReserveMib?: number;
  mmprojMib?: number;
}

export interface InitialOffloadEstimate {
  source: "tensor-directory" | "tensor-directory-partial" | "uniform-file-size" | "unavailable";
  blockCount: number;
  estimatedLayers: number;
  availableWeightBytes: number;
  estimatedGpuWeightBytes: number;
  globalTensorBytes: number;
  blockTensorBytes: number[];
  fullModelFits: boolean;
}

const MIB = 1024 * 1024;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function blockCountFrom(meta: GgufWeightMetadata): number {
  const declared = positiveInt(meta.gguf_block_count);
  const entries = Array.isArray(meta.gguf_block_tensor_bytes) ? meta.gguf_block_tensor_bytes : [];
  const highest = entries.reduce((max, entry) => Math.max(max, positiveInt(entry?.block + 1)), 0);
  return Math.max(declared, highest);
}

function fallbackBlockBytes(meta: GgufWeightMetadata, blockCount: number, known: number[], globalBytes: number): number {
  if (known.length > 0) return known.reduce((sum, value) => sum + value, 0) / known.length;
  const tensorBytes = finiteNonNegative(meta.gguf_tensor_bytes);
  if (tensorBytes !== null && tensorBytes > globalBytes) return (tensorBytes - globalBytes) / blockCount;
  const fileBytes = Math.max(0, finiteNonNegative(meta.size_mib) ?? 0) * MIB;
  return Math.max(0, fileBytes - globalBytes) / blockCount;
}

/**
 * Provides a coarse first position for load probing. It is intentionally not a
 * fit verdict: llama.cpp load probes calibrate KV, compute, recurrent state,
 * tensor placement, and driver-specific allocation around this estimate.
 */
export function estimateInitialOffload(
  meta: GgufWeightMetadata,
  options: InitialOffloadEstimateOptions,
): InitialOffloadEstimate {
  const blockCount = blockCountFrom(meta);
  if (blockCount === 0) {
    return {
      source: "unavailable",
      blockCount: 0,
      estimatedLayers: 0,
      availableWeightBytes: 0,
      estimatedGpuWeightBytes: 0,
      globalTensorBytes: 0,
      blockTensorBytes: [],
      fullModelFits: false,
    };
  }

  const entries = Array.isArray(meta.gguf_block_tensor_bytes) ? meta.gguf_block_tensor_bytes : [];
  const byBlock = new Map<number, number>();
  for (const entry of entries) {
    const block = positiveInt(entry?.block + 1) - 1;
    const bytes = finiteNonNegative(entry?.bytes);
    if (block >= 0 && block < blockCount && bytes !== null) byBlock.set(block, bytes);
  }
  const known = [...byBlock.values()].filter((value) => value > 0);
  const globalBytes = finiteNonNegative(meta.gguf_global_tensor_bytes) ?? 0;
  const fallback = fallbackBlockBytes(meta, blockCount, known, globalBytes);
  const blockTensorBytes = Array.from({ length: blockCount }, (_, block) => byBlock.get(block) ?? fallback);
  const completeDirectory = byBlock.size === blockCount && blockTensorBytes.every((value) => value > 0);
  const hasDirectory = byBlock.size > 0;
  const source = completeDirectory
    ? "tensor-directory"
    : hasDirectory
      ? "tensor-directory-partial"
      : "uniform-file-size";

  const availableMib = Math.max(0, finiteNonNegative(options.availableMib) ?? 0);
  const runtimeReserveMib = Math.max(0, finiteNonNegative(options.runtimeReserveMib) ?? 0);
  const mmprojMib = Math.max(0, finiteNonNegative(options.mmprojMib) ?? 0);
  const grossWeightBytes = Math.max(0, (availableMib - runtimeReserveMib - mmprojMib) * MIB);
  const availableWeightBytes = Math.max(0, grossWeightBytes - globalBytes);

  // llama.cpp offloads the last transformer blocks first. Non-uniform block
  // sizes therefore need cumulative accounting in reverse model order.
  let blockBytes = 0;
  let estimatedLayers = 0;
  for (let block = blockCount - 1; block >= 0; block -= 1) {
    const next = Math.max(0, blockTensorBytes[block] ?? 0);
    if (blockBytes + next > availableWeightBytes) break;
    blockBytes += next;
    estimatedLayers += 1;
  }

  return {
    source,
    blockCount,
    estimatedLayers,
    availableWeightBytes,
    estimatedGpuWeightBytes: globalBytes + blockBytes,
    globalTensorBytes: globalBytes,
    blockTensorBytes,
    fullModelFits: estimatedLayers === blockCount,
  };
}