import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { runFromPayload, type BenchRunnerDeps } from "./benchRunnerCli.js";
import { collectMetricSample, type MetricSample } from "./metricsPoller.js";
import {
  aggregateBenchResult,
  finalizeBenchRun,
  getFailureReason,
  type BenchConfig,
  type BenchItem,
  type BenchRun,
  type ResultCoreSession,
} from "./resultCore.js";
import { waitForServerReady } from "./serverLifecycle.js";
import type { StreamTelemetryEvent } from "./benchClient.js";
import {
  classifyRuntimeFailure,
  type RuntimeFailure,
} from "./failurePolicy.js";
import {
  inspectLlamaServer,
  supportsOption,
  validateLlamaArgs,
  type LlamaCapabilities,
} from "./llamaCompatibility.js";

export interface BenchCoordinatorPayload {
  item: BenchItem;
  cfg: BenchConfig & {
    bench?: {
      prompt?: string;
      n_predict?: number;
      port?: number;
      wait_sec_ready?: number;
      warmup?: boolean;
    };
  };
  runs: number;
  minimalPolling?: boolean;
  eventFile: string;
  logFile: string;
  session?: ResultCoreSession;
}

export interface BenchCoordinatorOutput {
  ok: boolean;
  result: Record<string, unknown>;
  runs: BenchRun[];
  attempts?: BenchRun[];
  error?: string;
  failure?: RuntimeFailure | null;
}

export interface CoordinatorDeps {
  spawnServer?: (executable: string, args: string[]) => ChildProcess;
  waitReady?: typeof waitForServerReady;
  collectSample?: (pid: number) => Promise<MetricSample>;
  runHttp?: typeof runFromPayload;
  httpDeps?: BenchRunnerDeps;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  clockMs?: () => number;
  inspectLlama?: (executable: string) => LlamaCapabilities;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const activeChildren = new Set<ChildProcess>();

export interface ProductionStreamState {
  inferencePhase: "warmup" | "kv_fill" | "throughput" | "latency_prompt" | "latency_reasoning" | "latency_answer";
  previousServerN: number | null;
  previousServerMs: number | null;
}

export interface ProductionStreamConsumerOptions {
  state: ProductionStreamState;
  minimalPolling: boolean;
  appendTelemetry: (extra: Record<string, unknown>) => void;
  forward?: (event: StreamTelemetryEvent) => void;
}

export function createProductionStreamConsumer(
  options: ProductionStreamConsumerOptions,
): (event: StreamTelemetryEvent) => void {
  return (event) => {
    const state = options.state;
    state.inferencePhase = event.kind === "reasoning" ? "latency_reasoning"
      : event.kind === "answer" ? "latency_answer" : "latency_prompt";
    const serverN = Number(event.timings?.predicted_n);
    const serverMs = Number(event.timings?.predicted_ms);
    const deltaN = Number.isFinite(serverN) && state.previousServerN !== null
      ? serverN - state.previousServerN : null;
    const deltaMs = Number.isFinite(serverMs) && state.previousServerMs !== null
      ? serverMs - state.previousServerMs : null;
    const localTps = deltaN !== null && deltaMs !== null && deltaN > 0 && deltaMs >= 0
      ? round(deltaN / Math.max(0.001, deltaMs / 1000), 2) : null;
    if (Number.isFinite(serverN)) state.previousServerN = serverN;
    if (Number.isFinite(serverMs)) state.previousServerMs = serverMs;
    if (!options.minimalPolling) {
      options.appendTelemetry({
        event_index: event.index,
        event_kind: event.kind,
        server_predicted_n: Number.isFinite(serverN) ? serverN : null,
        server_predicted_ms: Number.isFinite(serverMs) ? serverMs : null,
        server_tps: localTps,
        delivery_gap_ms: event.delivery_gap_ms ?? null,
        prompt_processed: event.prompt_progress?.processed ?? null,
        prompt_total: event.prompt_progress?.total ?? null,
        prompt_cache: event.prompt_progress?.cache ?? null,
        prompt_time_ms: event.prompt_progress?.time_ms ?? null,
      });
    }
    options.forward?.(event);
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface PowerSample {
  elapsed_ms: number;
  gpu_power_w: number;
}

export function integrateGpuEnergyWh(samples: PowerSample[], durationMs?: number): number {
  const points = samples
    .filter((sample) => Number.isFinite(sample.elapsed_ms) && Number.isFinite(sample.gpu_power_w))
    .map((sample) => ({
      elapsed_ms: Math.max(0, sample.elapsed_ms),
      gpu_power_w: Math.max(0, sample.gpu_power_w),
    }))
    .sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  if (points.length === 0) return 0;
  const endMs = Math.max(points.at(-1)?.elapsed_ms ?? 0, Number(durationMs) || 0);
  if (endMs > (points.at(-1)?.elapsed_ms ?? 0)) {
    points.push({ elapsed_ms: endMs, gpu_power_w: points.at(-1)?.gpu_power_w ?? 0 });
  }
  let joules = 0;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const seconds = Math.max(0, current.elapsed_ms - previous.elapsed_ms) / 1000;
    joules += ((previous.gpu_power_w + current.gpu_power_w) / 2) * seconds;
  }
  return joules / 3600;
}

function emit(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, "utf8");
}

function splitArgs(value: string | undefined): string[] {
  return String(value ?? "").split(/\s+/).filter(Boolean);
}

function serverArgs(payload: BenchCoordinatorPayload, capabilities: LlamaCapabilities): string[] {
  const port = payload.cfg.bench?.port ?? 18080;
  const slotSavePath = join(dirname(payload.logFile), "slots");
  mkdirSync(slotSavePath, { recursive: true });
  const args = ["-m", String(payload.item.model_path ?? "")];
  if (payload.item.mmproj_path) args.push("--mmproj", payload.item.mmproj_path);
  args.push(...splitArgs(payload.item.extra_args));
  args.push("--port", String(port), "--host", "127.0.0.1");
  if (supportsOption(capabilities, "--no-warmup")) args.push("--no-warmup");
  if (supportsOption(capabilities, "--cache-ram")) args.push("--cache-ram", "128");
  if (supportsOption(capabilities, "--slot-save-path")) args.push("--slot-save-path", slotSavePath);
  return args;
}

function stopChild(child: ChildProcess): void {
  activeChildren.delete(child);
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try { child.kill("SIGTERM"); } catch { }
  }
}

export function stopActiveBenchServers(): void {
  for (const child of [...activeChildren]) stopChild(child);
}

function emptySample(now = new Date()): MetricSample {
  return {
    at: now.toISOString(),
    gpu_mem_mib: 0,
    gpu_power_w: 0,
    gpu_temp_c: 0,
    gpu_util_pct: -1,
    cpu_util_pct: -1,
    process_vram_mib: -1,
    shared_mib: -1,
    ram_avail_mib: Math.trunc(os.freemem() / 1024 / 1024),
    disk_read_mb_s: 0,
  };
}

function mergeSample(run: BenchRun, sample: MetricSample, ramBaseline: number, sharedBaseline: number): void {
  const peak = Number(run.vram_peak_mib ?? 0);
  run.vram_peak_mib = Math.max(peak, sample.gpu_mem_mib);
  run.vram_total_peak_mib = Math.max(Number(run.vram_total_peak_mib ?? 0), sample.gpu_mem_mib);
  if (sample.process_vram_mib >= 0) {
    run.vram_process_peak_mib = Math.max(Number(run.vram_process_peak_mib ?? 0), sample.process_vram_mib);
    run.vram_external_peak_mib = Math.max(
      Number(run.vram_external_peak_mib ?? 0),
      Math.max(0, sample.gpu_mem_mib - sample.process_vram_mib),
    );
  }
  run.gpu_power_peak_w = round(Math.max(Number(run.gpu_power_peak_w ?? 0), sample.gpu_power_w), 1);
  run.gpu_temp_peak_c = Math.max(Number(run.gpu_temp_peak_c ?? 0), sample.gpu_temp_c);
  if (ramBaseline >= 0 && sample.ram_avail_mib >= 0) {
    run.ram_used_peak_mib = Math.max(Number(run.ram_used_peak_mib ?? 0), ramBaseline - sample.ram_avail_mib);
  }
  if (sample.shared_mib >= 0 && sharedBaseline >= 0) {
    run.shared_peak_mib = Math.max(Number(run.shared_peak_mib ?? 0), sample.shared_mib - sharedBaseline);
  }
  run.disk_read_peak_mb_s = round(Math.max(Number(run.disk_read_peak_mb_s ?? 0), sample.disk_read_mb_s), 1);
}

function failureResult(
  item: BenchItem,
  cfg: BenchCoordinatorPayload["cfg"],
  run: BenchRun,
  session?: ResultCoreSession,
): Record<string, unknown> {
  const result = {
    ...item,
    ...run,
    ok: false,
    bench_session_id: session?.bench_session_id || "unknown",
    bench_session_started_at: session?.bench_session_started_at || "",
    llama_server_version: session?.llama_server_version || "unknown",
    llama_server_exe: cfg.llama_server_exe || "",
  };
  return {
    ...result,
    failure_reason: getFailureReason(
      result,
      cfg.wddm_detection?.shared_delta_confirm_mib ?? 500,
    ),
  };
}

async function runOne(
  payload: BenchCoordinatorPayload,
  runIndex: number,
  capabilities: LlamaCapabilities,
  deps: CoordinatorDeps,
  attemptIndex = 1,
  maxAttempts = 3,
): Promise<BenchRun> {
  const now = deps.now ?? (() => new Date());
  const clockMs = deps.clockMs ?? (() => Date.now());
  const collect = deps.collectSample ?? ((pid: number) => collectMetricSample(pid, "nvidia-smi", () => new Date(), true));
  const waitReady = deps.waitReady ?? waitForServerReady;
  const runHttp = deps.runHttp ?? runFromPayload;
  const sleep = deps.sleep ?? sleepDefault;
  const executable = String(payload.cfg.llama_server_exe ?? "");
  const args = serverArgs(payload, capabilities);
  const baseUrl = `http://127.0.0.1:${payload.cfg.bench?.port ?? 18080}`;
  const timeoutMs = (payload.cfg.bench?.wait_sec_ready ?? 180) * 1000;

  const runStartedDate = now();
  const runStartedMs = clockMs();
  const powerSamples: PowerSample[] = [];
  const recordPower = (sample: MetricSample) => {
    powerSamples.push({
      elapsed_ms: Math.max(0, clockMs() - runStartedMs),
      gpu_power_w: sample.gpu_power_w,
    });
  };
  emit(payload.eventFile, "[phase] loading_model");
  const baseline = await collect(0).catch(() => emptySample(now()));
  recordPower(baseline);
  const ramBaseline = baseline.ram_avail_mib;
  const sharedBaseline = baseline.shared_mib;
  const vramTotal = payload.cfg.hardware?.vram_total_mib ?? 0;
  const baselinePct = vramTotal > 0 ? round((baseline.gpu_mem_mib / vramTotal) * 100, 1) : 0;
  const warningPct = Number(payload.cfg.preferences?.vram_usage_warning_pct ?? 10);
  emit(payload.eventFile, `[baseline] vram_used=${baseline.gpu_mem_mib} vram_total=${vramTotal} pct=${baselinePct} threshold=${warningPct}`);
  let stderr = "";
  const child = (deps.spawnServer ?? ((exe, argv) => spawn(exe, argv, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  })))(executable, args);
  activeChildren.add(child);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  const run: BenchRun = {
    run_index: runIndex,
    attempt_index: attemptIndex,
    timestamp: runStartedDate.toISOString().slice(0, 19),
    run_started_at: runStartedDate.toISOString(),
    vram_before_mib: baseline.gpu_mem_mib,
    vram_peak_mib: baseline.gpu_mem_mib,
    vram_baseline_mib: baseline.gpu_mem_mib,
    vram_baseline_pct: payload.cfg.hardware?.vram_total_mib
      ? round(baseline.gpu_mem_mib / payload.cfg.hardware.vram_total_mib, 4)
      : null,
    vram_total_peak_mib: baseline.gpu_mem_mib,
    vram_process_peak_mib: null,
    vram_external_peak_mib: null,
    shared_peak_mib: 0,
    load_sec: null,
    load_ms: null,
    ready: false,
    ok: false,
    error: null,
    ttft_sec: null,
    prompt_ms: null,
    ttfr_ms: null,
    e2e_ttft_ms: null,
    ttfh_ms: null,
    stream_open_ms: null,
    client_ttft_ms: null,
    e2e_first_reasoning_ms: null,
    e2e_first_content_ms: null,
    reasoning_delay_ms: null,
    e2e_latency_ms: null,
    server_prefill_ms: null,
    server_ttft_ms: null,
    tpot_ms: null,
    itl_p95_ms: null,
    delivery_gap_median_ms: null,
    delivery_gap_p95_ms: null,
    delivery_gap_max_ms: null,
    total_request_ms: null,
    latency_total_request_ms: null,
    latency_error: null,
    gpu_power_peak_w: baseline.gpu_power_w,
    gpu_temp_peak_c: baseline.gpu_temp_c,
    gpu_util_avg_pct: 0,
    cpu_util_avg_pct: 0,
    ram_baseline_mib: ramBaseline,
    ram_used_peak_mib: 0,
    disk_read_peak_mb_s: 0,
    telemetry: [],
  };

  const loadStarted = clockMs();
  let loadPollStopped = false;
  let utilTotal = 0;
  let utilCount = 0;
  let cpuUtilTotal = 0;
  let cpuUtilCount = 0;
  const loadPoll = async () => {
    while (!loadPollStopped && child.exitCode === null) {
      const sample = await collect(child.pid ?? 0).catch(() => emptySample(now()));
      recordPower(sample);
      mergeSample(run, sample, ramBaseline, sharedBaseline);
      if (sample.gpu_util_pct >= 0) {
        utilTotal += sample.gpu_util_pct;
        utilCount++;
      }
      if (sample.cpu_util_pct >= 0) {
        cpuUtilTotal += sample.cpu_util_pct;
        cpuUtilCount++;
      }
      if (!payload.minimalPolling) {
        emit(payload.eventFile, `[poll] gpu_mem=${sample.gpu_mem_mib} gpu_pow=${sample.gpu_power_w} gpu_temp=${sample.gpu_temp_c} gpu_util=${sample.gpu_util_pct} cpu_util=${sample.cpu_util_pct} ram_used=${Math.max(0, ramBaseline - sample.ram_avail_mib)} disk_r=${round(sample.disk_read_mb_s, 1)}`);
      }
      await sleep(500);
    }
  };
  const loadPollPromise = loadPoll();
  const readiness = await waitReady(baseUrl, timeoutMs, 250, {
    isExited: () => child.exitCode !== null,
  });
  loadPollStopped = true;
  await loadPollPromise;
  run.load_sec = round(readiness.loadMs / 1000, 2);
  run.load_ms = round(readiness.loadMs, 2);
  run.ready = readiness.ready;

  if (readiness.ready) {
    emit(payload.eventFile, "[phase] server_ready");
    emit(payload.eventFile, "[phase] sending_prompt");
    let inferenceStopped = false;
    const inferenceStartedMs = clockMs();
    const streamState: ProductionStreamState = {
      inferencePhase: "warmup",
      previousServerN: null,
      previousServerMs: null,
    };
    let lastInferenceSample = baseline;
    const appendTelemetry = (sample: MetricSample, extra: Record<string, unknown> = {}) => {
      const elapsedMs = Math.max(0, clockMs() - inferenceStartedMs);
      const points = run.telemetry ?? (run.telemetry = []);
      points.push({
        elapsed_ms: elapsedMs,
        phase: streamState.inferencePhase,
        ...extra,
        vram_total_mib: Math.max(0, sample.gpu_mem_mib),
        vram_run_mib: Math.max(0, sample.gpu_mem_mib - baseline.gpu_mem_mib),
        ram_used_mib: Math.max(0, ramBaseline - sample.ram_avail_mib),
        shared_mib: Math.max(0, sample.shared_mib - sharedBaseline),
        gpu_util_pct: sample.gpu_util_pct >= 0 ? sample.gpu_util_pct : null,
        cpu_util_pct: sample.cpu_util_pct >= 0 ? sample.cpu_util_pct : null,
        gpu_power_w: sample.gpu_power_w >= 0 ? sample.gpu_power_w : null,
      });
    };
    const inferencePoll = async () => {
      while (!inferenceStopped && child.exitCode === null) {
        const sample = await collect(child.pid ?? 0).catch(() => emptySample(now()));
        recordPower(sample);
        lastInferenceSample = sample;
        mergeSample(run, sample, ramBaseline, sharedBaseline);
        appendTelemetry(sample);
        if (sample.gpu_util_pct >= 0) {
          utilTotal += sample.gpu_util_pct;
          utilCount++;
        }
        if (sample.cpu_util_pct >= 0) {
          cpuUtilTotal += sample.cpu_util_pct;
          cpuUtilCount++;
        }
        await sleep(150);
      }
    };
    const inferencePollPromise = payload.minimalPolling ? Promise.resolve() : inferencePoll();
    const consumeProductionStreamEvent = createProductionStreamConsumer({
      state: streamState,
      minimalPolling: Boolean(payload.minimalPolling),
      appendTelemetry: (extra) => appendTelemetry(lastInferenceSample, extra),
      forward: deps.httpDeps?.onStreamEvent,
    });
    const http = await runHttp({
      baseUrl,
      prompt: payload.cfg.bench?.prompt ?? "",
      maxTokens: payload.cfg.bench?.n_predict ?? 128,
      workloadKind: payload.item.workload_kind ?? "baseline",
      prefillTargetTokens: payload.item.prefill_target_tokens ?? 0,
      kvFillTargetTokens: payload.item.kv_fill_target_tokens ?? 0,
      // b9608 cannot erase slots for multimodal servers. Skip the otherwise
      // optional warmup there so the measured request still starts cold.
      warmup: (payload.cfg.bench?.warmup ?? true) && !payload.item.mmproj_path,
      reasoningOff: payload.item.reasoning_mode === "off",
      timeoutMs: 900000,
    }, {
      ...deps.httpDeps,
      onPhase: (phase) => {
        streamState.inferencePhase = phase;
        deps.httpDeps?.onPhase?.(phase);
      },
      onStreamEvent: consumeProductionStreamEvent,
    });
    inferenceStopped = true;
    await inferencePollPromise;
    run.total_request_ms = http.total_request_ms;
    run.ttfr_ms = http.ttfr_ms;
    run.e2e_ttft_ms = http.e2e_ttft_ms;
    for (const field of [
      "ttfh_ms", "stream_open_ms", "client_ttft_ms", "e2e_first_reasoning_ms",
      "e2e_first_content_ms", "reasoning_delay_ms", "e2e_latency_ms", "server_prefill_ms",
      "server_ttft_ms", "tpot_ms", "itl_p95_ms", "delivery_gap_median_ms",
      "delivery_gap_p95_ms", "delivery_gap_max_ms",
    ] as const) run[field] = http[field];
    run.workload_prepare_ms = http.workload_prepare_ms;
    run.workload_prompt_tokens = http.workload_prompt_tokens;
    run.workload_target_error_tokens = http.workload_target_error_tokens;
    run.kv_fill_ms = http.kv_fill_ms;
    run.kv_fill_cached_tokens = http.kv_fill_cached_tokens;
    run.latency_total_request_ms = http.latency_total_request_ms;
    run.latency_error = null;
    run.ok = http.ok;
    run.error = http.ok ? null : (http.error ?? "HTTP benchmark failed");
    if (http.timings) {
      run.prompt_n = http.timings.prompt_n ?? null;
      run.prompt_tps = http.timings.prompt_per_second === undefined || http.timings.prompt_per_second === null
        ? null : round(http.timings.prompt_per_second, 2);
      run.prompt_ms = http.timings.prompt_ms === undefined || http.timings.prompt_ms === null
        ? null : round(http.timings.prompt_ms, 2);
      run.eval_n = http.timings.predicted_n ?? null;
      const predictedN = http.timings.predicted_n ?? 0;
      const predictedMs = http.timings.predicted_ms ?? 0;
      run.eval_tps = predictedN >= 2 && predictedMs > 0 && http.timings.predicted_per_second !== undefined
        && http.timings.predicted_per_second !== null
        ? round(http.timings.predicted_per_second, 2)
        : null;
      const headlineTtft = run.server_ttft_ms ?? run.client_ttft_ms ?? run.e2e_ttft_ms;
      run.ttft_sec = headlineTtft !== null && headlineTtft !== undefined
        ? round(Number(headlineTtft) / 1000, 3)
        : run.prompt_ms !== null && run.prompt_ms !== undefined
          ? round(Number(run.prompt_ms) / 1000, 3)
          : null;
    }
  } else {
    run.error = `server did not become ready (${readiness.reason})`;
  }

  const finalSample = await collect(child.pid ?? 0).catch(() => emptySample(now()));
  recordPower(finalSample);
  mergeSample(run, finalSample, ramBaseline, sharedBaseline);
  if (finalSample.gpu_util_pct >= 0) {
    utilTotal += finalSample.gpu_util_pct;
    utilCount++;
  }
  if (finalSample.cpu_util_pct >= 0) {
    cpuUtilTotal += finalSample.cpu_util_pct;
    cpuUtilCount++;
  }
  run.gpu_util_avg_pct = utilCount > 0 ? Math.trunc(utilTotal / utilCount) : 0;
  run.cpu_util_avg_pct = cpuUtilCount > 0 ? Math.trunc(cpuUtilTotal / cpuUtilCount) : 0;
  stopChild(child);
  await sleep(300);
  run.load_sec = run.load_sec ?? round((clockMs() - loadStarted) / 1000, 2);
  const runEndedDate = now();
  const runDurationMs = Math.max(0, clockMs() - runStartedMs);
  const gpuEnergyWh = integrateGpuEnergyWh(powerSamples, runDurationMs);
  run.run_ended_at = runEndedDate.toISOString();
  run.run_duration_ms = round(runDurationMs, 2);
  run.gpu_energy_wh = round(gpuEnergyWh, 4);
  run.gpu_energy_j = round(gpuEnergyWh * 3600, 2);

  mkdirSync(dirname(payload.logFile), { recursive: true });
  appendFileSync(payload.logFile, `===== RUN ${runIndex} =====\n[CMD] ${executable} ${args.join(" ")}\n\n===== STDERR (run ${runIndex}) =====\n${stderr}\n`, "utf8");
  emit(payload.eventFile, "[phase] run_complete");
  const finalized = finalizeBenchRun({ run, stderr, cfg: payload.cfg });
  finalized.failure = classifyRuntimeFailure({
    ok: finalized.ok,
    ready: finalized.ready,
    readinessReason: readiness.reason,
    error: finalized.error,
    stderr,
    fitStatus: finalized.fit_status,
    unsupportedArchitecture: finalized.unsupported_architecture,
    workloadKind: payload.item.workload_kind,
    attempt: attemptIndex,
    maxAttempts,
  });
  return finalized;
}

export async function runBenchCoordinator(
  payload: BenchCoordinatorPayload,
  deps: CoordinatorDeps = {},
): Promise<BenchCoordinatorOutput> {
  mkdirSync(dirname(payload.eventFile), { recursive: true });
  writeFileSync(payload.eventFile, "", "utf8");
  writeFileSync(payload.logFile, "", "utf8");
  const runs: BenchRun[] = [];
  const attempts: BenchRun[] = [];
  try {
    const executable = String(payload.cfg.llama_server_exe ?? "");
    const capabilities = (deps.inspectLlama ?? inspectLlamaServer)(executable);
    const compatibilityArgs = [
      "-m", String(payload.item.model_path ?? ""),
      ...(payload.item.mmproj_path ? ["--mmproj", payload.item.mmproj_path] : []),
      ...splitArgs(payload.item.extra_args),
      "--port", String(payload.cfg.bench?.port ?? 18080),
      "--host", "127.0.0.1",
    ];
    const compatibilityIssues = capabilities.ok
      ? validateLlamaArgs(compatibilityArgs, capabilities)
      : [capabilities.error ?? "could not inspect llama-server arguments"];
    if (compatibilityIssues.length > 0) {
      const run: BenchRun = {
        run_index: 0,
        timestamp: new Date().toISOString(),
        ready: false,
        ok: false,
        error: `llama.cpp compatibility check failed: ${compatibilityIssues.join("; ")}`,
      };
      run.failure = classifyRuntimeFailure({
        ok: false,
        ready: false,
        error: run.error,
        workloadKind: payload.item.workload_kind,
        attempt: 1,
        maxAttempts: 1,
      });
      return {
        ok: false,
        runs: [run],
        attempts: [run],
        result: failureResult(payload.item, payload.cfg, run, payload.session),
        error: String(run.error),
        failure: run.failure,
      };
    }
    const count = Math.max(1, Math.trunc(payload.runs));
    const maxAttempts = 3;
    for (let i = 0; i < count; i++) {
      if (count > 1) emit(payload.eventFile, `  run ${i + 1}/${count}`);
      let completed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) emit(payload.eventFile, `  retry ${attempt}/${maxAttempts}`);
        const run = await runOne(payload, i, capabilities, deps, attempt, maxAttempts);
        attempts.push(run);
        if (run.ok === true) {
          runs.push(run);
          completed = true;
          break;
        }
        if (!run.failure?.retryable || run.failure.retry_exhausted) {
          return {
            ok: false,
            runs,
            attempts,
            result: failureResult(payload.item, payload.cfg, run, payload.session),
            error: typeof run.error === "string" ? run.error : "benchmark run failed",
            failure: run.failure,
          };
        }
      }
      if (!completed) {
        const lastAttempt = attempts.at(-1) as BenchRun;
        return {
          ok: false,
          runs,
          attempts,
          result: failureResult(payload.item, payload.cfg, lastAttempt, payload.session),
          error: typeof lastAttempt.error === "string" ? lastAttempt.error : "benchmark run failed",
          failure: lastAttempt.failure ?? null,
        };
      }
    }
    const result = aggregateBenchResult({
      item: payload.item,
      cfg: payload.cfg,
      runs,
      session: payload.session,
    });
    result.failure_reason = null;
    return { ok: true, result, runs, attempts };
  } finally {
    stopActiveBenchServers();
  }
}
