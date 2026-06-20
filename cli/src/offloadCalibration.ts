import { createServer } from "node:net";
import { collectMetricSample, type MetricSample } from "./metricsPoller.js";
import { estimateInitialOffload, type GgufWeightMetadata } from "./offloadEstimator.js";
import { buildOffloadBenchmarkCandidates, estimateOffloadCliff, type OffloadProbeObservation } from "./offloadPlanner.js";
import { runLoadProbe, type LoadProbePayload, type LoadProbeResult } from "./offloadProbe.js";

export interface OffloadCalibrationPayload {
  executable: string;
  modelPath: string;
  mmprojPath?: string | null;
  mmprojMib?: number;
  baseArgs: string[];
  host?: string;
  contextSize: number;
  kvType: string;
  timeoutMs: number;
  vramTotalMib: number;
  safetyFraction: number;
  sharedConfirmMib?: number;
  metadata: GgufWeightMetadata;
  planning?: {
    runtimeReserveMib?: number;
    benchmarkOffsets?: number[];
    maxProbeCount?: number;
    stableSampleCount?: number;
    stableToleranceMib?: number;
    maxReadySamples?: number;
    sampleIntervalMs?: number;
  };
}

export interface OffloadCalibrationResult {
  mode: "context" | "offload" | "fallback";
  calibrated: boolean;
  block_count: number;
  baseline_vram_mib: number | null;
  safe_cap_mib: number;
  available_mib: number;
  structural_estimate_layers: number;
  predicted_fit_layers: number;
  verified_fit_layers: number | null;
  first_spill_layers: number | null;
  benchmark_layers: number[];
  probe_count: number;
  probes: LoadProbeResult[];
  reason: string;
}

export interface OffloadCalibrationDeps {
  collectBaseline?: () => Promise<MetricSample>;
  findPort?: () => Promise<number>;
  runProbe?: (payload: LoadProbePayload) => Promise<LoadProbeResult>;
}

function removeOption(args: string[], names: string[], takesValue = true): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (!names.includes(args[i])) {
      out.push(args[i]);
      continue;
    }
    if (takesValue && i + 1 < args.length) i += 1;
  }
  return out;
}

export function buildOffloadProbeArgs(payload: OffloadCalibrationPayload, layers: number, port: number): string[] {
  let base = [...payload.baseArgs];
  base = removeOption(base, ["--gpu-layers", "-ngl"]);
  base = removeOption(base, ["--ctx-size", "-c"]);
  base = removeOption(base, ["--cache-type-k", "-ctk"]);
  base = removeOption(base, ["--cache-type-v", "-ctv"]);
  base = removeOption(base, ["--port"]);
  base = removeOption(base, ["--host"]);
  base = removeOption(base, ["--fit", "-fit"]);
  base = removeOption(base, ["--cache-ram"]);
  base = base.filter((arg) => arg !== "--no-warmup");
  const args = ["-m", payload.modelPath];
  if (payload.mmprojPath) args.push("--mmproj", payload.mmprojPath);
  args.push(
    ...base,
    "--ctx-size", String(Math.max(1, Math.trunc(payload.contextSize))),
    "--gpu-layers", String(Math.max(0, Math.trunc(layers))),
    "--cache-type-k", payload.kvType,
    "--cache-type-v", payload.kvType,
    "--fit", "off",
    "--no-warmup",
    "--cache-ram", "0",
    "--host", payload.host ?? "127.0.0.1",
    "--port", String(port),
  );
  return args;
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

function failedResult(payload: OffloadCalibrationPayload, reason: string, baseline: number | null, structural = 0): OffloadCalibrationResult {
  const safeCap = Math.max(0, Math.floor(payload.vramTotalMib * payload.safetyFraction));
  return {
    mode: "fallback", calibrated: false,
    block_count: Math.max(0, Math.trunc(payload.metadata.gguf_block_count ?? 0)),
    baseline_vram_mib: baseline, safe_cap_mib: safeCap,
    available_mib: Math.max(0, safeCap - (baseline ?? 0)),
    structural_estimate_layers: structural, predicted_fit_layers: structural,
    verified_fit_layers: null, first_spill_layers: null,
    benchmark_layers: [], probe_count: 0, probes: [], reason,
  };
}

export async function calibrateOffload(
  payload: OffloadCalibrationPayload,
  deps: OffloadCalibrationDeps = {},
): Promise<OffloadCalibrationResult> {
  const blockCount = Math.max(0, Math.trunc(payload.metadata.gguf_block_count ?? 0));
  if (blockCount === 0) return failedResult(payload, "GGUF block count unavailable", null);
  const baselineSample = await (deps.collectBaseline ?? (() => collectMetricSample(0, "nvidia-smi", () => new Date(), true)))();
  const baseline = Number.isFinite(baselineSample.gpu_mem_mib) ? Math.max(0, baselineSample.gpu_mem_mib) : null;
  const safeCap = Math.max(0, Math.floor(payload.vramTotalMib * payload.safetyFraction));
  const available = Math.max(0, safeCap - (baseline ?? 0));
  const mmprojMib = payload.mmprojPath ? Math.max(0, payload.mmprojMib ?? 0) : 0;
  const structural = estimateInitialOffload(payload.metadata, {
    availableMib: available,
    runtimeReserveMib: payload.planning?.runtimeReserveMib ?? 512,
    mmprojMib,
  });
  if (structural.source === "unavailable") return failedResult(payload, "GGUF weight estimate unavailable", baseline);

  const probes: LoadProbeResult[] = [];
  const observations: OffloadProbeObservation[] = [];
  const maxProbeCount = Math.max(1, Math.trunc(payload.planning?.maxProbeCount ?? 4));
  const runProbe = deps.runProbe ?? runLoadProbe;
  const findPort = deps.findPort ?? freePort;
  let cliff = estimateOffloadCliff({
    blockCount, safeCapMib: safeCap, initialEstimate: structural.estimatedLayers,
    probes: observations, maxProbeCount,
  });

  while (!cliff.complete && cliff.next_probe_layers !== null && probes.length < maxProbeCount) {
    const port = await findPort();
    const requested = cliff.next_probe_layers;
    const result = await runProbe({
      executable: payload.executable,
      args: buildOffloadProbeArgs(payload, requested, port),
      baseUrl: `http://${payload.host ?? "127.0.0.1"}:${port}`,
      timeoutMs: payload.timeoutMs,
      requestedLayers: requested,
      vramTotalMib: payload.vramTotalMib,
      safetyFraction: payload.safetyFraction,
      sharedConfirmMib: payload.sharedConfirmMib,
      stableSampleCount: payload.planning?.stableSampleCount,
      stableToleranceMib: payload.planning?.stableToleranceMib,
      maxReadySamples: payload.planning?.maxReadySamples,
      sampleIntervalMs: payload.planning?.sampleIntervalMs,
    });
    probes.push(result);
    observations.push(result);
    cliff = estimateOffloadCliff({
      blockCount, safeCapMib: safeCap, initialEstimate: structural.estimatedLayers,
      probes: observations, maxProbeCount,
    });
  }

  const verified = cliff.verified_fit_layers;
  if (verified === blockCount) {
    return {
      mode: "context", calibrated: true, block_count: blockCount,
      baseline_vram_mib: baseline, safe_cap_mib: safeCap, available_mib: available,
      structural_estimate_layers: structural.estimatedLayers,
      predicted_fit_layers: cliff.predicted_fit_layers,
      verified_fit_layers: verified, first_spill_layers: cliff.first_spill_layers,
      benchmark_layers: [], probe_count: probes.length, probes,
      reason: "full model offload verified under safe cap",
    };
  }
  if (verified === null) {
    return {
      ...failedResult(payload, "no safe GPU-layer probe was verified", baseline, structural.estimatedLayers),
      predicted_fit_layers: cliff.predicted_fit_layers,
      first_spill_layers: cliff.first_spill_layers,
      probe_count: probes.length,
      probes,
    };
  }
  return {
    mode: "offload", calibrated: true, block_count: blockCount,
    baseline_vram_mib: baseline, safe_cap_mib: safeCap, available_mib: available,
    structural_estimate_layers: structural.estimatedLayers,
    predicted_fit_layers: cliff.predicted_fit_layers,
    verified_fit_layers: verified, first_spill_layers: cliff.first_spill_layers,
    benchmark_layers: buildOffloadBenchmarkCandidates(verified, blockCount, payload.planning?.benchmarkOffsets),
    probe_count: probes.length, probes,
    reason: cliff.complete ? cliff.reason : "bounded calibration used the best verified fit",
  };
}