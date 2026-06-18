export interface BenchItem {
  id?: string;
  label?: string;
  model?: string;
  variant?: string;
  series?: string;
  level?: string;
  sweep?: string;
  reasoning_mode?: string | null;
  template_note?: string | null;
  gguf_context_length?: number | null;
  gguf_architecture?: string | null;
  model_path?: string;
  mmproj_path?: string | null;
  extra_args?: string;
}

export interface BenchConfig {
  llama_server_exe?: string;
  hardware?: {
    vram_total_mib?: number | null;
  };
  wddm_detection?: {
    shared_delta_confirm_mib?: number | null;
    vram_saturation_threshold?: number | null;
  };
  preferences?: {
    vram_usage_warning_pct?: number | null;
  };
}

export interface BenchRun {
  [key: string]: unknown;
  run_index?: number;
  timestamp?: string;
  vram_before_mib?: number | null;
  vram_peak_mib?: number | null;
  vram_baseline_mib?: number | null;
  vram_baseline_pct?: number | null;
  vram_total_peak_mib?: number | null;
  vram_process_peak_mib?: number | null;
  vram_external_peak_mib?: number | null;
  shared_peak_mib?: number | null;
  load_sec?: number | null;
  load_ms?: number | null;
  ready?: boolean | null;
  ok?: boolean | null;
  error?: string | null;
  prompt_n?: number | null;
  prompt_tps?: number | null;
  eval_n?: number | null;
  eval_tps?: number | null;
  cpu_model_mib?: number | null;
  cuda_model_mib?: number | null;
  kv_cache_mib?: number | null;
  compute_cuda_mib?: number | null;
  compute_host_mib?: number | null;
  layers_offloaded?: string | null;
  fit_status?: string | null;
  unsupported_architecture?: string | null;
  ttft_sec?: number | null;
  prompt_ms?: number | null;
  ttfr_ms?: number | null;
  e2e_ttft_ms?: number | null;
  total_request_ms?: number | null;
  latency_total_request_ms?: number | null;
  latency_error?: string | null;
  gpu_power_peak_w?: number | null;
  gpu_temp_peak_c?: number | null;
  gpu_util_avg_pct?: number | null;
  cpu_util_avg_pct?: number | null;
  ram_baseline_mib?: number | null;
  ram_used_peak_mib?: number | null;
  disk_read_peak_mb_s?: number | null;
  telemetry?: BenchTelemetryPoint[];
}

export interface BenchTelemetryPoint {
  elapsed_ms: number;
  phase: "warmup" | "throughput" | "latency_prompt" | "latency_eval";
  token_index?: number | null;
  rolling_tps?: number | null;
  vram_total_mib: number;
  vram_run_mib: number;
  ram_used_mib: number;
  shared_mib: number;
  gpu_util_pct: number | null;
  cpu_util_pct: number | null;
}

export interface ResultCoreSession {
  bench_session_id?: string;
  bench_session_started_at?: string;
  llama_server_version?: string;
}

export const METRIC_SCHEMA_VERSION = 2;

export const METRIC_GLOSSARY = {
  load_ms: "Process start to /v1/models readiness; model load plus backend initialization.",
  prompt_ms: "llama.cpp prompt-processing (prefill) duration for the measured request.",
  prompt_tps: "Prompt-processing throughput reported by llama.cpp.",
  ttfr_ms: "End-to-end time to the first streamed response event.",
  e2e_ttft_ms: "End-to-end time to the first streamed generated content.",
  eval_tps: "Decode throughput for generated tokens; the primary speed metric.",
  total_request_ms: "Full non-streaming throughput-request duration, excluding model load.",
  latency_total_request_ms: "Full short streaming latency-request duration.",
  vram_baseline_mib: "System dedicated VRAM already used before the run.",
  vram_peak_mib: "Peak system dedicated VRAM observed during the run.",
  shared_peak_mib: "Peak shared/spill GPU memory above the pre-run baseline.",
  ram_used_peak_mib: "Peak reduction in available system RAM relative to the pre-run baseline.",
  gpu_util_avg_pct: "Average GPU utilization across collected samples.",
  cpu_util_avg_pct: "Average total CPU utilization across collected samples.",
  telemetry: "Time-series samples for benchmark phase, memory pressure, utilization, and rolling streamed output speed.",
} as const;

export interface ParsedLlamaServerStderr {
  cpu_model_mib?: number;
  cuda_model_mib?: number;
  kv_cache_mib?: number;
  compute_cuda_mib?: number;
  compute_host_mib?: number;
  layers_offloaded?: string;
  unsupported_architecture?: string;
  fit_status: "success" | "failed_but_running" | "unknown";
}

export function median(values: Array<number | null | undefined> | null | undefined): number | null {
  if (!values) return null;
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function int(value: unknown, fallback = 0): number {
  const n = num(value);
  return n === null ? fallback : Math.trunc(n);
}

function max(values: Array<number | null | undefined>): number {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length === 0 ? 0 : Math.max(...nums);
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

export function inferFitStatus(status: string | null | undefined, ok: boolean, sharedPeakMib: number, sharedConfirmMib = 500): string | null | undefined {
  if (status === "success" || status === "failed_but_running") return status;
  if (!ok) return status;
  return sharedPeakMib > sharedConfirmMib ? "failed_but_running" : "success";
}

export function parseLlamaServerStderr(stderr: string): ParsedLlamaServerStderr {
  const out: ParsedLlamaServerStderr = { fit_status: "unknown" };
  type NumericStderrKey =
    | "cpu_model_mib"
    | "cuda_model_mib"
    | "kv_cache_mib"
    | "compute_cuda_mib"
    | "compute_host_mib";
  const numeric: Array<[NumericStderrKey, RegExp]> = [
    ["cpu_model_mib", /CPU model buffer size\s*=\s*([\d.]+)/],
    ["cuda_model_mib", /CUDA0 model buffer size\s*=\s*([\d.]+)/],
    ["kv_cache_mib", /CUDA0 KV buffer size\s*=\s*([\d.]+)/],
    ["compute_cuda_mib", /CUDA0 compute buffer size\s*=\s*([\d.]+)/],
    ["compute_host_mib", /CUDA_Host compute buffer size\s*=\s*([\d.]+)/],
  ];
  for (const [key, pattern] of numeric) {
    const match = stderr.match(pattern);
    if (match) out[key] = Number.parseFloat(match[1]);
  }
  const layers = stderr.match(/offloaded (\d+)\/(\d+) layers/);
  if (layers) out.layers_offloaded = `${layers[1]}/${layers[2]}`;
  const architecture = stderr.match(/unknown model architecture: '([^']+)'/);
  if (architecture) out.unsupported_architecture = architecture[1];
  if (/successfully fit params/.test(stderr)) out.fit_status = "success";
  else if (/failed to fit params/.test(stderr)) out.fit_status = "failed_but_running";
  return out;
}

export function finalizeBenchRun(payload: {
  run: BenchRun;
  stderr: string;
  cfg: BenchConfig;
}): BenchRun {
  const parsed = parseLlamaServerStderr(payload.stderr);
  const vramTotal = int(payload.cfg.hardware?.vram_total_mib);
  const peakVram = int(payload.run.vram_peak_mib);
  const sharedPeak = int(payload.run.shared_peak_mib);
  const confirm = int(payload.cfg.wddm_detection?.shared_delta_confirm_mib, 500);
  const threshold = num(payload.cfg.wddm_detection?.vram_saturation_threshold) ?? 0.92;
  const saturation = vramTotal > 0 ? peakVram / vramTotal : 0;
  return {
    metric_schema_version: METRIC_SCHEMA_VERSION,
    ...payload.run,
    ...parsed,
    fit_status: inferFitStatus(parsed.fit_status, payload.run.ok === true, sharedPeak, confirm),
    wddm_vram_saturation: round(saturation, 3),
    wddm_flag_high_vram: saturation > threshold,
    wddm_flag_shared_pos: sharedPeak > confirm,
  };
}

export function getFailureReason(result: Record<string, unknown>, sharedConfirmMib = 500): string | null {
  if (result.ok === true) return null;
  if (result.unsupported_architecture) return "unsupported_arch";
  if (result.fit_status === "failed_but_running") return "vram_overflow";
  if (int(result.shared_peak_mib) > sharedConfirmMib) return "vram_overflow";
  if (result.ready === false) return "server_timeout";
  return "other";
}

export function contextSizeFromArgs(extraArgs: string | null | undefined): number | null {
  const m = String(extraArgs ?? "").match(/--ctx-size\s+(\d+)/);
  if (!m) return null;
  const parsed = Number.parseInt(m[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function deriveResultFields(result: Record<string, unknown>, vramTotalMib: number): {
  time_total_sec: number | null;
  headroom_mib: number;
  ctx_size: number | null;
} {
  const promptN = int(result.prompt_n);
  const evalN = int(result.eval_n);
  const promptTps = num(result.prompt_tps) ?? 0;
  const evalTps = num(result.eval_tps) ?? 0;
  const timeTotal = promptN > 0 && evalN > 0 && promptTps > 0 && evalTps > 0
    ? round((promptN / promptTps) + (evalN / evalTps), 2)
    : null;
  const headroom = Math.max(0, Math.trunc(vramTotalMib) - int(result.vram_peak_mib));
  return {
    time_total_sec: timeTotal,
    headroom_mib: headroom,
    ctx_size: contextSizeFromArgs(typeof result.extra_args === "string" ? result.extra_args : ""),
  };
}

export function runStats(result: Record<string, unknown>): {
  run_count: number;
  first_eval_tps: number | null;
  repeat_eval_tps: number | null;
  eval_min_tps: number | null;
  eval_max_tps: number | null;
  eval_spread_pct: number;
} {
  const runs = Array.isArray(result.runs) ? result.runs as Array<Record<string, unknown>> : [];
  let samples = runs.map((r) => num(r.eval_tps)).filter((v): v is number => v !== null);
  if (samples.length === 0) {
    const top = num(result.eval_tps);
    if (top !== null) samples = [top];
  }
  const runCount = num(result.run_count) ?? (runs.length > 0 ? runs.length : samples.length);
  const first = num(result.first_eval_tps) ?? (samples.length > 0 ? samples[0] : null);
  const repeat = num(result.repeat_eval_tps) ?? (samples.length > 1 ? median(samples.slice(1)) : null);
  const minEval = num(result.eval_min_tps) ?? (samples.length > 0 ? Math.min(...samples) : null);
  const maxEval = num(result.eval_max_tps) ?? (samples.length > 0 ? Math.max(...samples) : null);
  const spread = num(result.eval_spread_pct) ?? (
    samples.length > 1 && num(result.eval_tps) !== null && (num(result.eval_tps) ?? 0) > 0 && minEval !== null && maxEval !== null
      ? round(((maxEval - minEval) / (num(result.eval_tps) as number)) * 100, 1)
      : 0
  );
  return {
    run_count: Math.trunc(runCount),
    first_eval_tps: roundOrNull(first, 2),
    repeat_eval_tps: roundOrNull(repeat, 2),
    eval_min_tps: roundOrNull(minEval, 2),
    eval_max_tps: roundOrNull(maxEval, 2),
    eval_spread_pct: spread,
  };
}

export function buildReportRows(
  results: Array<Record<string, unknown>>,
  vramTotalMib: number,
): Array<Record<string, unknown>> {
  const coldByModel = new Map<string, { disk: number; loadMs: number | null }>();
  const ordered = [...results].sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  for (const result of ordered) {
    const model = String(result.model ?? "");
    const disk = num(result.disk_read_peak_mb_s) ?? 0;
    const loadMs = num(result.load_ms) ?? (num(result.load_sec) === null ? null : round((num(result.load_sec) as number) * 1000, 2));
    const current = coldByModel.get(model);
    if (!current || disk > current.disk) coldByModel.set(model, { disk, loadMs });
  }

  return results.map((result) => {
    const cold = coldByModel.get(String(result.model ?? ""));
    return {
      ...result,
      metric_schema_version: num(result.metric_schema_version) ?? METRIC_SCHEMA_VERSION,
      failure_reason: result.failure_reason ?? null,
      unsupported_architecture: result.unsupported_architecture ?? null,
      ready: result.ready ?? null,
      prompt_ms: num(result.prompt_ms),
      ttfr_ms: num(result.ttfr_ms),
      e2e_ttft_ms: num(result.e2e_ttft_ms),
      total_request_ms: num(result.total_request_ms),
      latency_total_request_ms: num(result.latency_total_request_ms),
      latency_error: result.latency_error ?? null,
      gpu_power_peak_w: num(result.gpu_power_peak_w),
      gpu_temp_peak_c: num(result.gpu_temp_peak_c),
      gpu_util_avg_pct: num(result.gpu_util_avg_pct),
      cpu_util_avg_pct: num(result.cpu_util_avg_pct),
      ram_used_peak_mib: num(result.ram_used_peak_mib),
      ram_baseline_mib: num(result.ram_baseline_mib),
      disk_read_peak_mb_s: num(result.disk_read_peak_mb_s),
      vram_baseline_mib: num(result.vram_baseline_mib),
      vram_baseline_pct: num(result.vram_baseline_pct),
      vram_total_peak_mib: num(result.vram_total_peak_mib),
      vram_process_peak_mib: num(result.vram_process_peak_mib),
      vram_external_peak_mib: num(result.vram_external_peak_mib),
      load_ms: num(result.load_ms) ?? (num(result.load_sec) === null ? null : round((num(result.load_sec) as number) * 1000, 2)),
      model_cold_load_ms: cold?.loadMs ?? null,
      model_cold_disk_read_peak_mb_s: cold?.disk ?? null,
      ...deriveResultFields(result, vramTotalMib),
      ...runStats(result),
    };
  });
}

export function aggregateBenchResult(payload: {
  item: BenchItem;
  cfg: BenchConfig;
  runs: BenchRun[];
  session?: ResultCoreSession;
}): Record<string, unknown> {
  const item = payload.item;
  const cfg = payload.cfg;
  const runs = payload.runs;
  if (!Array.isArray(runs) || runs.length === 0) throw new Error("aggregateBenchResult requires at least one run");
  const first = runs[0];
  const vramTotal = int(cfg.hardware?.vram_total_mib);
  const confirm = int(cfg.wddm_detection?.shared_delta_confirm_mib, 500);
  const satThreshold = num(cfg.wddm_detection?.vram_saturation_threshold) ?? 0.92;

  const vramPeakMed = int(median(runs.map((r) => num(r.vram_peak_mib))));
  const vramTotalPeakMed = int(median(runs.map((r) => num(r.vram_total_peak_mib) ?? num(r.vram_peak_mib))));
  const vramProcessPeakMed = median(runs.map((r) => num(r.vram_process_peak_mib)));
  const vramExternalPeakMed = median(runs.map((r) => num(r.vram_external_peak_mib)));
  const vramBaselineMed = median(runs.map((r) => num(r.vram_baseline_mib) ?? num(r.vram_before_mib)));
  const vramBaselinePctMed = median(runs.map((r) => num(r.vram_baseline_pct)));
  const sharedPeakMed = int(median(runs.map((r) => num(r.shared_peak_mib))));
  const promptTpsMed = round(median(runs.map((r) => num(r.prompt_tps))) ?? 0, 2);
  const evalTpsMed = round(median(runs.map((r) => num(r.eval_tps))) ?? 0, 2);
  const evalStats = runStats({ eval_tps: evalTpsMed, runs });

  const promptMs = median(runs.map((r) => num(r.prompt_ms)));
  const ttfrMs = median(runs.map((r) => num(r.ttfr_ms)));
  const e2eTtftMs = median(runs.map((r) => num(r.e2e_ttft_ms)));
  const totalReqMs = median(runs.map((r) => num(r.total_request_ms)));
  const latReqMs = median(runs.map((r) => num(r.latency_total_request_ms)));
  const satRatio = vramTotal > 0 ? round(vramPeakMed / vramTotal, 3) : 0;

  return {
    metric_schema_version: METRIC_SCHEMA_VERSION,
    id: item.id,
    label: item.label,
    model: item.model,
    variant: item.variant,
    series: item.series,
    level: item.level,
    sweep: item.sweep,
    reasoning_mode: item.reasoning_mode,
    template_note: item.template_note,
    gguf_context_length: item.gguf_context_length,
    gguf_architecture: item.gguf_architecture,
    timestamp: first.timestamp,
    model_path: item.model_path,
    mmproj_path: item.mmproj_path,
    extra_args: item.extra_args,
    vram_before_mib: first.vram_before_mib,
    vram_baseline_mib: roundOrNull(vramBaselineMed, 0),
    vram_baseline_pct: roundOrNull(vramBaselinePctMed, 4),
    load_sec: first.load_sec,
    load_ms: num(first.load_ms) ?? (num(first.load_sec) === null ? null : round((num(first.load_sec) as number) * 1000, 2)),
    ready: first.ready,
    prompt_n: first.prompt_n,
    eval_n: first.eval_n,
    cpu_model_mib: first.cpu_model_mib,
    cuda_model_mib: first.cuda_model_mib,
    kv_cache_mib: first.kv_cache_mib,
    compute_cuda_mib: first.compute_cuda_mib,
    compute_host_mib: first.compute_host_mib,
    layers_offloaded: first.layers_offloaded,
    fit_status: inferFitStatus(first.fit_status, true, sharedPeakMed, confirm),
    vram_peak_mib: vramPeakMed,
    vram_total_peak_mib: vramTotalPeakMed,
    vram_process_peak_mib: roundOrNull(vramProcessPeakMed, 0),
    vram_external_peak_mib: roundOrNull(vramExternalPeakMed, 0),
    shared_peak_mib: sharedPeakMed,
    prompt_tps: promptTpsMed,
    eval_tps: evalTpsMed,
    ...evalStats,
    ttft_sec: round(median(runs.map((r) => num(r.ttft_sec))) ?? 0, 3),
    prompt_ms: roundOrNull(promptMs, 2),
    ttfr_ms: roundOrNull(ttfrMs, 2),
    e2e_ttft_ms: roundOrNull(e2eTtftMs, 2),
    total_request_ms: roundOrNull(totalReqMs, 2),
    latency_total_request_ms: roundOrNull(latReqMs, 2),
    gpu_util_avg_pct: int(median(runs.map((r) => num(r.gpu_util_avg_pct)))),
    cpu_util_avg_pct: int(median(runs.map((r) => num(r.cpu_util_avg_pct)))),
    gpu_power_peak_w: round(max(runs.map((r) => num(r.gpu_power_peak_w))), 1),
    gpu_temp_peak_c: int(max(runs.map((r) => num(r.gpu_temp_peak_c)))),
    ram_baseline_mib: first.ram_baseline_mib,
    ram_used_peak_mib: int(max(runs.map((r) => num(r.ram_used_peak_mib)))),
    disk_read_peak_mb_s: round(max(runs.map((r) => num(r.disk_read_peak_mb_s))), 1),
    wddm_vram_saturation: satRatio,
    wddm_flag_high_vram: satRatio > satThreshold,
    wddm_flag_shared_pos: sharedPeakMed > confirm,
    ok: true,
    error: null,
    bench_session_id: payload.session?.bench_session_id || "unknown",
    bench_session_started_at: payload.session?.bench_session_started_at || "",
    llama_server_version: payload.session?.llama_server_version || "unknown",
    llama_server_exe: cfg.llama_server_exe || "",
    runs,
  };
}
