import { createServer } from "node:net";
import { collectMetricSample, type MetricSample } from "../bench/metricsPoller.js";
import { estimateOffloadCliff, type OffloadProbeObservation } from "./offloadPlanner.js";
import { runLoadProbe, type LoadProbePayload, type LoadProbeResult } from "./offloadProbe.js";
import type { GgufWeightMetadata } from "./offloadEstimator.js";

export interface MoeCalibrationPayload {
  executable: string;
  modelPath: string;
  baseArgs: string[];
  host?: string;
  contextSize: number;
  kvType: string;
  timeoutMs: number;
  vramTotalMib: number;
  safetyFraction: number;
  metadata: GgufWeightMetadata;
  planning?: {
    runtimeReserveMib?: number;
    benchmarkOffsets?: number[];
    benchmarkRatios?: number[];
    tailOffsets?: number[];
    maxProbeCount?: number;
    stableSampleCount?: number;
    stableToleranceMib?: number;
    maxReadySamples?: number;
    sampleIntervalMs?: number;
  };
}

export interface MoeProbeResult extends LoadProbeResult {
  n_cpu_moe: number;
  expert_gpu_layers: number;
}

export interface MoeCalibrationResult {
  mode: "moe-cpu" | "fallback";
  planning_mode: "adaptive-moe";
  calibrated: boolean;
  expert_block_count: number;
  baseline_vram_mib: number | null;
  safe_cap_mib: number;
  structural_n_cpu_moe: number;
  predicted_n_cpu_moe: number;
  verified_n_cpu_moe: number | null;
  first_spill_n_cpu_moe: number | null;
  benchmark_n_cpu_moe: number[];
  probe_count: number;
  probes: MoeProbeResult[];
  reason: string;
}

export interface MoeCalibrationDeps {
  collectBaseline?: () => Promise<MetricSample>;
  findPort?: () => Promise<number>;
  runProbe?: (payload: LoadProbePayload) => Promise<LoadProbeResult>;
  onProbe?: (event: {
    current: number;
    total: number;
    nCpuMoe: number;
    expertGpuLayers: number;
    result?: LoadProbeResult;
  }) => void;
}

export function buildMoeBenchmarkCandidates(
  loadFitAnchor: number,
  expertBlockCount: number,
  offsets: number[] = [-3, -1, 0, 1, 3],
  ratios: number[] = [0.5, 0.75],
  tailOffsets: number[] = [-3, -1, 0],
): number[] {
  const count = Math.max(0, Math.trunc(expertBlockCount));
  const anchor = Math.max(0, Math.min(count, Math.trunc(loadFitAnchor)));
  const candidates = new Set<number>();
  const add = (value: number) => candidates.add(Math.max(0, Math.min(count, Math.trunc(value))));

  for (const offset of offsets) add(anchor + offset);
  for (const ratio of ratios) {
    if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) add(Math.round(count * ratio));
  }
  for (const offset of tailOffsets) add(count + offset);
  return [...candidates].sort((a, b) => a - b);
}

function removeOption(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (!names.includes(args[i])) out.push(args[i]);
    else if (i + 1 < args.length) i += 1;
  }
  return out;
}

function expertBlocks(metadata: GgufWeightMetadata): Array<{ block: number; bytes: number; expert_bytes: number }> {
  return (metadata.gguf_block_tensor_bytes ?? [])
    .map((entry) => ({
      block: Math.trunc(entry.block),
      bytes: Math.max(0, entry.bytes),
      expert_bytes: Math.max(0, entry.expert_bytes ?? 0),
    }))
    .filter((entry) => entry.expert_bytes > 0)
    .sort((a, b) => a.block - b.block);
}

export function estimateInitialCpuMoe(
  metadata: GgufWeightMetadata,
  availableMib: number,
  runtimeReserveMib = 512,
): { expertBlockCount: number; nCpuMoe: number } | null {
  const blocks = expertBlocks(metadata);
  if (blocks.length === 0) return null;
  const totalBytes = Math.max(0, metadata.gguf_tensor_bytes ?? 0);
  const expertBytes = blocks.reduce((sum, block) => sum + block.expert_bytes, 0);
  let gpuBytes = Math.max(0, totalBytes - expertBytes) + expertBytes;
  const budgetBytes = Math.max(0, availableMib - Math.max(0, runtimeReserveMib)) * 1024 * 1024;
  let nCpuMoe = 0;
  while (nCpuMoe < blocks.length && gpuBytes > budgetBytes) {
    gpuBytes -= blocks[nCpuMoe].expert_bytes;
    nCpuMoe += 1;
  }
  return { expertBlockCount: blocks.length, nCpuMoe };
}

export function buildMoeProbeArgs(
  payload: MoeCalibrationPayload,
  nCpuMoe: number,
  port: number,
): string[] {
  let base = [...payload.baseArgs];
  base = removeOption(base, ["--gpu-layers", "-ngl"]);
  base = removeOption(base, ["--n-cpu-moe", "-ncmoe"]);
  base = removeOption(base, ["--ctx-size", "-c"]);
  base = removeOption(base, ["--cache-type-k", "-ctk"]);
  base = removeOption(base, ["--cache-type-v", "-ctv"]);
  base = removeOption(base, ["--port", "--host", "--fit", "-fit", "--cache-ram"]);
  base = base.filter((arg) => arg !== "--no-warmup" && arg !== "--cpu-moe" && arg !== "-cmoe");
  return [
    "-m", payload.modelPath,
    ...base,
    "--ctx-size", String(Math.max(1, Math.trunc(payload.contextSize))),
    "--gpu-layers", "99",
    "--n-cpu-moe", String(Math.max(0, Math.trunc(nCpuMoe))),
    "--cache-type-k", payload.kvType,
    "--cache-type-v", payload.kvType,
    "--fit", "off",
    "--no-warmup",
    "--cache-ram", "0",
    "--host", payload.host ?? "127.0.0.1",
    "--port", String(port),
  ];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("could not allocate a probe port");
  return port;
}

function fallback(payload: MoeCalibrationPayload, reason: string, expertBlockCount = 0, baseline: number | null = null): MoeCalibrationResult {
  return {
    mode: "fallback", planning_mode: "adaptive-moe", calibrated: false,
    expert_block_count: expertBlockCount, baseline_vram_mib: baseline,
    safe_cap_mib: Math.max(0, Math.floor(payload.vramTotalMib * payload.safetyFraction)),
    structural_n_cpu_moe: 0, predicted_n_cpu_moe: 0,
    verified_n_cpu_moe: null, first_spill_n_cpu_moe: null,
    benchmark_n_cpu_moe: [], probe_count: 0, probes: [], reason,
  };
}

export async function calibrateMoe(
  payload: MoeCalibrationPayload,
  deps: MoeCalibrationDeps = {},
): Promise<MoeCalibrationResult> {
  const baselineSample = await (deps.collectBaseline ?? (() => collectMetricSample(0, "nvidia-smi", () => new Date(), true)))();
  const baseline = Number.isFinite(baselineSample.gpu_mem_mib) ? Math.max(0, baselineSample.gpu_mem_mib) : null;
  const safeCap = Math.max(0, Math.floor(payload.vramTotalMib * payload.safetyFraction));
  const structural = estimateInitialCpuMoe(
    payload.metadata,
    Math.max(0, safeCap - (baseline ?? 0)),
    payload.planning?.runtimeReserveMib,
  );
  if (!structural) return fallback(payload, "GGUF expert tensor metadata unavailable", 0, baseline);

  const expertCount = structural.expertBlockCount;
  const initialGpuExperts = expertCount - structural.nCpuMoe;
  const probes: MoeProbeResult[] = [];
  const observations: OffloadProbeObservation[] = [];
  const maxProbeCount = Math.max(1, Math.trunc(payload.planning?.maxProbeCount ?? 4));
  const runProbe = deps.runProbe ?? runLoadProbe;
  const findPort = deps.findPort ?? freePort;
  let cliff = estimateOffloadCliff({
    blockCount: expertCount, safeCapMib: safeCap, initialEstimate: initialGpuExperts,
    probes: observations, maxProbeCount,
  });

  while (!cliff.complete && cliff.next_probe_layers !== null && probes.length < maxProbeCount) {
    const expertGpuLayers = cliff.next_probe_layers;
    const nCpuMoe = expertCount - expertGpuLayers;
    const port = await findPort();
    deps.onProbe?.({
      current: probes.length + 1,
      total: maxProbeCount,
      nCpuMoe,
      expertGpuLayers,
    });
    const raw = await runProbe({
      executable: payload.executable,
      args: buildMoeProbeArgs(payload, nCpuMoe, port),
      baseUrl: `http://${payload.host ?? "127.0.0.1"}:${port}`,
      timeoutMs: payload.timeoutMs,
      requestedLayers: expertGpuLayers,
      vramTotalMib: payload.vramTotalMib,
      safetyFraction: payload.safetyFraction,
      stableSampleCount: payload.planning?.stableSampleCount,
      stableToleranceMib: payload.planning?.stableToleranceMib,
      maxReadySamples: payload.planning?.maxReadySamples,
      sampleIntervalMs: payload.planning?.sampleIntervalMs,
    });
    deps.onProbe?.({
      current: probes.length + 1,
      total: maxProbeCount,
      nCpuMoe,
      expertGpuLayers,
      result: raw,
    });
    const probe = { ...raw, n_cpu_moe: nCpuMoe, expert_gpu_layers: expertGpuLayers };
    probes.push(probe);
    observations.push({ ...raw, requested_layers: expertGpuLayers, offloaded_layers: null });
    cliff = estimateOffloadCliff({
      blockCount: expertCount, safeCapMib: safeCap, initialEstimate: initialGpuExperts,
      probes: observations, maxProbeCount,
    });
  }

  if (cliff.verified_fit_layers === null) {
    return {
      ...fallback(payload, "no safe MoE allocation was verified", expertCount, baseline),
      structural_n_cpu_moe: structural.nCpuMoe,
      predicted_n_cpu_moe: expertCount - cliff.predicted_fit_layers,
      first_spill_n_cpu_moe: cliff.first_spill_layers === null ? null : expertCount - cliff.first_spill_layers,
      probe_count: probes.length, probes,
    };
  }
  const verifiedNcpu = expertCount - cliff.verified_fit_layers;
  const benchmarkCandidates = buildMoeBenchmarkCandidates(
    verifiedNcpu,
    expertCount,
    payload.planning?.benchmarkOffsets,
    payload.planning?.benchmarkRatios,
    payload.planning?.tailOffsets,
  );
  return {
    mode: "moe-cpu", planning_mode: "adaptive-moe", calibrated: true,
    expert_block_count: expertCount, baseline_vram_mib: baseline, safe_cap_mib: safeCap,
    structural_n_cpu_moe: structural.nCpuMoe,
    predicted_n_cpu_moe: expertCount - cliff.predicted_fit_layers,
    verified_n_cpu_moe: verifiedNcpu,
    first_spill_n_cpu_moe: cliff.first_spill_layers === null ? null : expertCount - cliff.first_spill_layers,
    benchmark_n_cpu_moe: benchmarkCandidates,
    probe_count: probes.length, probes,
    reason: cliff.reason,
  };
}
