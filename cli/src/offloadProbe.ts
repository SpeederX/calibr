import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { collectMetricSample, type MetricSample } from "./metricsPoller.js";
import { parseLlamaServerStderr } from "./resultCore.js";
import { stopProcessTree, waitForServerReady } from "./serverLifecycle.js";

export interface LoadProbePayload {
  executable: string;
  args: string[];
  baseUrl: string;
  timeoutMs: number;
  requestedLayers: number;
  vramTotalMib: number;
  safetyFraction: number;
  sharedConfirmMib?: number;
  stableSampleCount?: number;
  stableToleranceMib?: number;
  maxReadySamples?: number;
  sampleIntervalMs?: number;
}

export interface LoadProbeResult {
  requested_layers: number;
  offloaded_layers: number | null;
  total_layers: number | null;
  ready: boolean;
  load_ms: number | null;
  vram_total_mib: number;
  vram_safe_cap_mib: number;
  vram_baseline_mib: number | null;
  vram_ready_mib: number | null;
  vram_run_mib: number | null;
  process_vram_ready_mib: number | null;
  shared_growth_mib: number | null;
  cpu_model_mib: number | null;
  cuda_model_mib: number | null;
  kv_cache_mib: number | null;
  compute_cuda_mib: number | null;
  compute_host_mib: number | null;
  fit_under_safe_cap: boolean;
  stable: boolean;
  sample_count: number;
  stderr: string;
  error: string | null;
}

export interface LoadProbeDeps {
  spawnServer?: (executable: string, args: string[]) => ChildProcess;
  waitReady?: typeof waitForServerReady;
  collectSample?: (pid: number) => Promise<MetricSample>;
  stopServer?: (child: ChildProcess) => void;
  sleep?: (ms: number) => Promise<void>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function fallbackSample(): MetricSample {
  return {
    at: new Date().toISOString(), gpu_mem_mib: 0, gpu_power_w: 0,
    gpu_temp_c: 0, gpu_util_pct: -1, cpu_util_pct: -1,
    process_vram_mib: -1, shared_mib: -1,
    ram_avail_mib: Math.trunc(os.freemem() / 1024 / 1024), disk_read_mb_s: 0,
  };
}

export function memorySamplesStable(samples: MetricSample[], count = 3, toleranceMib = 16): boolean {
  const required = Math.max(1, Math.trunc(count));
  const values = samples.map((sample) => finite(sample.gpu_mem_mib))
    .filter((value): value is number => value !== null).slice(-required);
  if (values.length < required) return false;
  return Math.max(...values) - Math.min(...values) <= Math.max(0, toleranceMib);
}

function parseLayers(value: string | undefined): { offloaded: number | null; total: number | null } {
  const match = String(value ?? "").match(/^(\d+)\/(\d+)$/);
  return match ? { offloaded: Number.parseInt(match[1], 10), total: Number.parseInt(match[2], 10) }
    : { offloaded: null, total: null };
}

function maxMetric(samples: MetricSample[], select: (sample: MetricSample) => number): number | null {
  const values = samples.map(select).map(finite).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

export async function runLoadProbe(payload: LoadProbePayload, deps: LoadProbeDeps = {}): Promise<LoadProbeResult> {
  const collect = deps.collectSample ?? ((pid: number) => collectMetricSample(pid, "nvidia-smi", () => new Date(), true));
  const waitReady = deps.waitReady ?? waitForServerReady;
  const stopServer = deps.stopServer ?? stopProcessTree;
  const sleep = deps.sleep ?? delay;
  const safeCap = Math.max(0, Math.floor(payload.vramTotalMib * payload.safetyFraction));
  const baseline = await collect(0).catch(() => fallbackSample());
  let child: ChildProcess | null = null;
  let stderr = "";
  let ready = false;
  let loadMs: number | null = null;
  let error: string | null = null;
  const readySamples: MetricSample[] = [];

  try {
    child = (deps.spawnServer ?? ((executable, args) => spawn(executable, args, {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    })))(payload.executable, payload.args);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const readiness = await waitReady(payload.baseUrl, payload.timeoutMs, 250, {
      isExited: () => child?.exitCode !== null,
    });
    ready = readiness.ready;
    loadMs = readiness.loadMs;
    if (!ready) error = `server did not become ready (${readiness.reason})`;

    if (ready) {
      const maxSamples = Math.max(1, Math.trunc(payload.maxReadySamples ?? 8));
      const stableCount = Math.max(1, Math.trunc(payload.stableSampleCount ?? 3));
      const tolerance = Math.max(0, payload.stableToleranceMib ?? 16);
      for (let i = 0; i < maxSamples; i += 1) {
        readySamples.push(await collect(child.pid ?? 0).catch(() => fallbackSample()));
        if (memorySamplesStable(readySamples, stableCount, tolerance)) break;
        if (i + 1 < maxSamples) await sleep(payload.sampleIntervalMs ?? 200);
      }
    }
  } catch (probeError) {
    error = probeError instanceof Error ? probeError.message : String(probeError);
  } finally {
    if (child) {
      stopServer(child);
      await sleep(50);
    }
  }

  const parsed = parseLlamaServerStderr(stderr);
  const layers = parseLayers(parsed.layers_offloaded);
  const vramReady = maxMetric(readySamples, (sample) => sample.gpu_mem_mib);
  const processReady = maxMetric(readySamples, (sample) => sample.process_vram_mib);
  const sharedReady = maxMetric(readySamples, (sample) => sample.shared_mib);
  const vramBaseline = finite(baseline.gpu_mem_mib);
  const sharedBaseline = finite(baseline.shared_mib);
  const sharedGrowth = sharedReady !== null && sharedBaseline !== null ? Math.max(0, sharedReady - sharedBaseline) : null;
  const vramRun = vramReady !== null && vramBaseline !== null ? Math.max(0, vramReady - vramBaseline) : null;
  const stable = memorySamplesStable(readySamples, payload.stableSampleCount ?? 3, payload.stableToleranceMib ?? 16);
  // Shared memory is diagnostic here, not a fit veto. With intentional CPU
  // offload, WDDM can expose CPU-backed model buffers as shared GPU memory;
  // fewer GPU layers may therefore report more shared usage without paging.
  // Dedicated VRAM against the safe cap, readiness, and llama.cpp's explicit
  // fit result are the reliable load-only boundary signals.
  const fit = ready && vramReady !== null && vramReady <= safeCap
    && parsed.fit_status !== "failed_but_running";

  return {
    requested_layers: Math.max(0, Math.trunc(payload.requestedLayers)),
    offloaded_layers: layers.offloaded, total_layers: layers.total,
    ready, load_ms: loadMs,
    vram_total_mib: Math.max(0, Math.trunc(payload.vramTotalMib)), vram_safe_cap_mib: safeCap,
    vram_baseline_mib: vramBaseline, vram_ready_mib: vramReady, vram_run_mib: vramRun,
    process_vram_ready_mib: processReady, shared_growth_mib: sharedGrowth,
    cpu_model_mib: finite(parsed.cpu_model_mib), cuda_model_mib: finite(parsed.cuda_model_mib),
    kv_cache_mib: finite(parsed.kv_cache_mib), compute_cuda_mib: finite(parsed.compute_cuda_mib),
    compute_host_mib: finite(parsed.compute_host_mib), fit_under_safe_cap: fit,
    stable, sample_count: readySamples.length, stderr, error,
  };
}
