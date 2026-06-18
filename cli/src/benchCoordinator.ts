import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
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
  error?: string;
}

export interface CoordinatorDeps {
  spawnServer?: (executable: string, args: string[]) => ChildProcess;
  waitReady?: typeof waitForServerReady;
  collectSample?: (pid: number) => Promise<MetricSample>;
  runHttp?: typeof runFromPayload;
  httpDeps?: BenchRunnerDeps;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const activeChildren = new Set<ChildProcess>();

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function emit(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, "utf8");
}

function splitArgs(value: string | undefined): string[] {
  return String(value ?? "").split(/\s+/).filter(Boolean);
}

function serverArgs(payload: BenchCoordinatorPayload): string[] {
  const port = payload.cfg.bench?.port ?? 18080;
  const args = ["-m", String(payload.item.model_path ?? "")];
  if (payload.item.mmproj_path) args.push("--mmproj", payload.item.mmproj_path);
  args.push(...splitArgs(payload.item.extra_args));
  args.push("--port", String(port), "--host", "127.0.0.1", "--no-warmup", "--cache-ram", "128");
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
  deps: CoordinatorDeps,
): Promise<BenchRun> {
  const now = deps.now ?? (() => new Date());
  const collect = deps.collectSample ?? ((pid: number) => collectMetricSample(pid, "nvidia-smi", () => new Date(), true));
  const waitReady = deps.waitReady ?? waitForServerReady;
  const runHttp = deps.runHttp ?? runFromPayload;
  const sleep = deps.sleep ?? sleepDefault;
  const executable = String(payload.cfg.llama_server_exe ?? "");
  const args = serverArgs(payload);
  const baseUrl = `http://127.0.0.1:${payload.cfg.bench?.port ?? 18080}`;
  const timeoutMs = (payload.cfg.bench?.wait_sec_ready ?? 180) * 1000;

  emit(payload.eventFile, "[phase] loading_model");
  const baseline = await collect(0).catch(() => emptySample(now()));
  const ramBaseline = baseline.ram_avail_mib;
  const sharedBaseline = baseline.shared_mib;
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
    timestamp: now().toISOString().slice(0, 19),
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
    ready: false,
    ok: false,
    error: null,
    ttft_sec: null,
    prompt_ms: null,
    ttfr_ms: null,
    e2e_ttft_ms: null,
    total_request_ms: null,
    latency_total_request_ms: null,
    latency_error: null,
    gpu_power_peak_w: baseline.gpu_power_w,
    gpu_temp_peak_c: baseline.gpu_temp_c,
    gpu_util_avg_pct: 0,
    ram_baseline_mib: ramBaseline,
    ram_used_peak_mib: 0,
    disk_read_peak_mb_s: 0,
  };

  const loadStarted = Date.now();
  let loadPollStopped = false;
  let utilTotal = 0;
  let utilCount = 0;
  const loadPoll = async () => {
    while (!loadPollStopped && child.exitCode === null) {
      const sample = await collect(child.pid ?? 0).catch(() => emptySample(now()));
      mergeSample(run, sample, ramBaseline, sharedBaseline);
      if (sample.gpu_util_pct >= 0) {
        utilTotal += sample.gpu_util_pct;
        utilCount++;
      }
      if (!payload.minimalPolling) {
        emit(payload.eventFile, `[poll] gpu_mem=${sample.gpu_mem_mib} gpu_pow=${sample.gpu_power_w} gpu_temp=${sample.gpu_temp_c} gpu_util=${sample.gpu_util_pct} ram_used=${Math.max(0, ramBaseline - sample.ram_avail_mib)} disk_r=${round(sample.disk_read_mb_s, 1)}`);
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
  run.ready = readiness.ready;

  if (readiness.ready) {
    emit(payload.eventFile, "[phase] server_ready");
    emit(payload.eventFile, "[phase] sending_prompt");
    let inferenceStopped = false;
    const inferencePoll = async () => {
      while (!inferenceStopped && child.exitCode === null) {
        const sample = await collect(child.pid ?? 0).catch(() => emptySample(now()));
        mergeSample(run, sample, ramBaseline, sharedBaseline);
        if (sample.gpu_util_pct >= 0) {
          utilTotal += sample.gpu_util_pct;
          utilCount++;
        }
        await sleep(150);
      }
    };
    const inferencePollPromise = payload.minimalPolling ? Promise.resolve() : inferencePoll();
    const http = await runHttp({
      baseUrl,
      prompt: payload.cfg.bench?.prompt ?? "",
      maxTokens: payload.cfg.bench?.n_predict ?? 128,
      warmup: payload.cfg.bench?.warmup ?? true,
      reasoningOff: payload.item.reasoning_mode === "off",
      timeoutMs: 900000,
    }, deps.httpDeps);
    inferenceStopped = true;
    await inferencePollPromise;
    run.total_request_ms = http.total_request_ms;
    run.ttfr_ms = http.ttfr_ms;
    run.e2e_ttft_ms = http.e2e_ttft_ms;
    run.latency_total_request_ms = http.latency_total_request_ms;
    run.latency_error = http.latency_error ?? null;
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
      run.ttft_sec = run.e2e_ttft_ms !== null && run.e2e_ttft_ms !== undefined
        ? round(Number(run.e2e_ttft_ms) / 1000, 3)
        : run.prompt_ms !== null && run.prompt_ms !== undefined
          ? round(Number(run.prompt_ms) / 1000, 3)
          : null;
    }
  } else {
    run.error = `server did not become ready (${readiness.reason})`;
  }

  const finalSample = await collect(child.pid ?? 0).catch(() => emptySample(now()));
  mergeSample(run, finalSample, ramBaseline, sharedBaseline);
  if (finalSample.gpu_util_pct >= 0) {
    utilTotal += finalSample.gpu_util_pct;
    utilCount++;
  }
  run.gpu_util_avg_pct = utilCount > 0 ? Math.trunc(utilTotal / utilCount) : 0;
  stopChild(child);
  await sleep(300);
  run.load_sec = run.load_sec ?? round((Date.now() - loadStarted) / 1000, 2);

  mkdirSync(dirname(payload.logFile), { recursive: true });
  appendFileSync(payload.logFile, `===== RUN ${runIndex} =====\n[CMD] ${executable} ${args.join(" ")}\n\n===== STDERR (run ${runIndex}) =====\n${stderr}\n`, "utf8");
  emit(payload.eventFile, "[phase] run_complete");
  return finalizeBenchRun({ run, stderr, cfg: payload.cfg });
}

export async function runBenchCoordinator(
  payload: BenchCoordinatorPayload,
  deps: CoordinatorDeps = {},
): Promise<BenchCoordinatorOutput> {
  mkdirSync(dirname(payload.eventFile), { recursive: true });
  writeFileSync(payload.eventFile, "", "utf8");
  writeFileSync(payload.logFile, "", "utf8");
  const runs: BenchRun[] = [];
  try {
    const count = Math.max(1, Math.trunc(payload.runs));
    for (let i = 0; i < count; i++) {
      if (count > 1) emit(payload.eventFile, `  run ${i + 1}/${count}`);
      const run = await runOne(payload, i, deps);
      runs.push(run);
      if (run.ok !== true) {
        return {
          ok: false,
          runs,
          result: failureResult(payload.item, payload.cfg, run, payload.session),
          error: typeof run.error === "string" ? run.error : "benchmark run failed",
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
    return { ok: true, result, runs };
  } finally {
    stopActiveBenchServers();
  }
}
