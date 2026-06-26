import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildChatCompletionRequest,
  eraseLlamaSlot,
  runNonStreamingChatCompletion,
  runStreamingChatCompletion,
  type ChatCompletionRequest,
  type LlamaTimings,
  type NonStreamingChatCompletionResult,
  type StreamingChatCompletionResult,
  type StreamTelemetryEvent,
} from "../bench/benchClient.js";
import { collectMetricSample, type MetricSample } from "../bench/metricsPoller.js";
import { waitForServerReady } from "../bench/serverLifecycle.js";
import {
  createProductionStreamConsumer,
  type ProductionStreamState,
} from "../bench/benchCoordinator.js";

export type UatMode = "nonstream" | "stream_drain" | "stream_production";

export interface StreamingOverheadServer {
  executable: string;
  args: string[];
  readyTimeoutMs?: number;
}

export interface StreamingOverheadPayload {
  baseUrl: string;
  config: string;
  prompt: string;
  repetitions?: number;
  maxTokens?: number;
  seed?: number;
  slotId?: number;
  cooldownMs?: number;
  timeoutMs?: number;
  reasoningOff?: boolean;
  metricsPid?: number;
  server?: StreamingOverheadServer;
}

export interface UatMemorySummary {
  gpu_mem_baseline_mib: number | null;
  gpu_mem_peak_mib: number | null;
  process_vram_peak_mib: number | null;
  ram_growth_peak_mib: number | null;
}

export interface StreamingOverheadRun {
  config: string;
  mode: UatMode;
  repetition: number;
  order: number;
  ok: boolean;
  status: number;
  error?: string;
  prompt_n: number | null;
  prompt_ms: number | null;
  predicted_n: number | null;
  predicted_ms: number | null;
  server_eval_tps: number | null;
  client_first_to_last_ms: number | null;
  client_eval_tps: number | null;
  cache_n: number | null;
  exact_token_count: boolean;
  cache_empty: boolean | null;
  total_request_ms: number;
  memory: UatMemorySummary;
}

export interface ModeSummary {
  runs: number;
  valid_runs: number;
  median_predicted_ms: number | null;
  median_server_eval_tps: number | null;
  median_client_eval_tps: number | null;
}

export interface StreamingOverheadSummary {
  nonstream: ModeSummary;
  stream_drain: ModeSummary;
  stream_production: ModeSummary;
  drain_vs_nonstream_delta_tps: number | null;
  drain_vs_nonstream_delta_pct: number | null;
  drain_vs_nonstream_overhead_ms_per_token: number | null;
  production_vs_drain_delta_tps: number | null;
  production_vs_drain_delta_pct: number | null;
  production_vs_drain_overhead_ms_per_token: number | null;
  paired_server_path: PairedComparison;
  paired_production_consumer: PairedComparison;
  server_path_assessment: "clean" | "overhead-consistent" | "inconclusive" | "insufficient-data";
  production_consumer_assessment: "clean" | "backpressure-consistent" | "inconclusive" | "insufficient-data";
  interpretation: "streaming-clean" | "server-overhead-candidate" | "client-backpressure-candidate" | "inconclusive" | "insufficient-data";
}

export interface PairedComparison {
  blocks: number;
  positive_blocks: number;
  median_delta_pct: number | null;
  min_delta_pct: number | null;
  max_delta_pct: number | null;
  median_overhead_ms_per_token: number | null;
}

export interface StreamingOverheadOutput {
  schema_version: 1;
  generated_at: string;
  config: string;
  max_tokens: number;
  repetitions_per_mode: number;
  order: UatMode[];
  runs: StreamingOverheadRun[];
  summary: StreamingOverheadSummary;
}

interface RunDeps {
  resetSlot?: (baseUrl: string, slotId: number) => Promise<void>;
  runNonstream?: (request: ChatCompletionRequest) => Promise<NonStreamingChatCompletionResult>;
  runStream?: (
    request: ChatCompletionRequest,
    onEvent: (event: StreamTelemetryEvent) => void,
    deferEventProcessing: boolean,
  ) => Promise<StreamingChatCompletionResult>;
  sample?: (pid: number) => Promise<MetricSample>;
  sleep?: (ms: number) => Promise<void>;
  progress?: (message: string) => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildBalancedOrder(repetitionsPerMode: number): UatMode[] {
  const repetitions = Math.max(1, Math.trunc(repetitionsPerMode));
  const order: UatMode[] = [];
  let nonstream = 0;
  let streamDrain = 0;
  let streamProduction = 0;
  const block: UatMode[] = [
    "nonstream", "stream_drain", "stream_production",
    "stream_production", "stream_drain", "nonstream",
  ];
  while (nonstream < repetitions || streamDrain < repetitions || streamProduction < repetitions) {
    for (const mode of block) {
      if (mode === "nonstream" && nonstream < repetitions) {
        order.push(mode);
        nonstream++;
      } else if (mode === "stream_drain" && streamDrain < repetitions) {
        order.push(mode);
        streamDrain++;
      } else if (mode === "stream_production" && streamProduction < repetitions) {
        order.push(mode);
        streamProduction++;
      }
    }
  }
  return order;
}

function summarizeMode(runs: StreamingOverheadRun[], mode: UatMode): ModeSummary {
  const selected = runs.filter((run) => run.mode === mode);
  const valid = selected.filter((run) => run.ok && run.exact_token_count && run.cache_empty !== false);
  return {
    runs: selected.length,
    valid_runs: valid.length,
    median_predicted_ms: finite(median(valid.map((run) => run.predicted_ms))),
    median_server_eval_tps: finite(median(valid.map((run) => run.server_eval_tps))),
    median_client_eval_tps: finite(median(valid.map((run) => run.client_eval_tps))),
  };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pairedComparisons(runs: StreamingOverheadRun[], maxTokens: number): {
  server: PairedComparison;
  production: PairedComparison;
} {
  const serverDeltas: number[] = [];
  const serverOverheads: number[] = [];
  const productionDeltas: number[] = [];
  const productionOverheads: number[] = [];
  const ordered = runs.slice().sort((a, b) => a.order - b.order);
  for (let index = 0; index + 5 < ordered.length; index += 6) {
    const block = ordered.slice(index, index + 6);
    const expected: UatMode[] = [
      "nonstream", "stream_drain", "stream_production",
      "stream_production", "stream_drain", "nonstream",
    ];
    if (!block.every((run, position) =>
      run.mode === expected[position] && run.ok && run.exact_token_count &&
      run.cache_empty !== false && run.predicted_ms !== null
    )) continue;
    const a = mean([block[0].predicted_ms!, block[5].predicted_ms!]);
    const b = mean([block[1].predicted_ms!, block[4].predicted_ms!]);
    const c = mean([block[2].predicted_ms!, block[3].predicted_ms!]);
    if (a === null || b === null || c === null || a <= 0 || b <= 0) continue;
    serverDeltas.push((b - a) / a * 100);
    serverOverheads.push((b - a) / maxTokens);
    productionDeltas.push((c - b) / b * 100);
    productionOverheads.push((c - b) / maxTokens);
  }
  const summarize = (deltas: number[], overheads: number[]): PairedComparison => ({
    blocks: deltas.length,
    positive_blocks: deltas.filter((value) => value > 0).length,
    median_delta_pct: finite(median(deltas)),
    min_delta_pct: deltas.length ? Math.min(...deltas) : null,
    max_delta_pct: deltas.length ? Math.max(...deltas) : null,
    median_overhead_ms_per_token: finite(median(overheads)),
  });
  return { server: summarize(serverDeltas, serverOverheads), production: summarize(productionDeltas, productionOverheads) };
}

function assessPaired<T extends "overhead-consistent" | "backpressure-consistent">(
  comparison: PairedComparison,
  overheadLabel: T,
): "clean" | T | "inconclusive" | "insufficient-data" {
  if (comparison.blocks < 3 || comparison.median_delta_pct === null) return "insufficient-data";
  const consistentPositive = comparison.positive_blocks >= Math.ceil(comparison.blocks * 0.75);
  if (consistentPositive && comparison.median_delta_pct > 1) return overheadLabel;
  const range = Math.max(
    Math.abs(comparison.min_delta_pct ?? Infinity),
    Math.abs(comparison.max_delta_pct ?? Infinity),
  );
  if (Math.abs(comparison.median_delta_pct) <= 1 && range <= 3) return "clean";
  return "inconclusive";
}

export function summarizeStreamingOverhead(
  runs: StreamingOverheadRun[],
  maxTokens: number,
): StreamingOverheadSummary {
  const nonstream = summarizeMode(runs, "nonstream");
  const streamDrain = summarizeMode(runs, "stream_drain");
  const streamProduction = summarizeMode(runs, "stream_production");
  const nonTps = nonstream.median_server_eval_tps;
  const drainTps = streamDrain.median_server_eval_tps;
  const productionTps = streamProduction.median_server_eval_tps;
  const drainDeltaTps = nonTps === null || drainTps === null ? null : drainTps - nonTps;
  const drainDeltaPct = drainDeltaTps === null || nonTps === null || nonTps === 0
    ? null : drainDeltaTps / nonTps * 100;
  const drainOverhead = nonstream.median_predicted_ms === null || streamDrain.median_predicted_ms === null
    ? null
    : (streamDrain.median_predicted_ms - nonstream.median_predicted_ms) / maxTokens;
  const productionDeltaTps = drainTps === null || productionTps === null ? null : productionTps - drainTps;
  const productionDeltaPct = productionDeltaTps === null || drainTps === null || drainTps === 0
    ? null : productionDeltaTps / drainTps * 100;
  const productionOverhead = streamDrain.median_predicted_ms === null || streamProduction.median_predicted_ms === null
    ? null
    : (streamProduction.median_predicted_ms - streamDrain.median_predicted_ms) / maxTokens;
  const paired = pairedComparisons(runs, maxTokens);
  const serverAssessment = assessPaired(paired.server, "overhead-consistent");
  const productionAssessment = assessPaired(paired.production, "backpressure-consistent");
  let interpretation: StreamingOverheadSummary["interpretation"] = "inconclusive";
  if (serverAssessment === "insufficient-data" || productionAssessment === "insufficient-data") {
    interpretation = "insufficient-data";
  } else if (productionAssessment === "backpressure-consistent") {
    interpretation = "client-backpressure-candidate";
  } else if (serverAssessment === "overhead-consistent") {
    interpretation = "server-overhead-candidate";
  } else if (serverAssessment === "clean" && productionAssessment === "clean") {
    interpretation = "streaming-clean";
  }
  return {
    nonstream,
    stream_drain: streamDrain,
    stream_production: streamProduction,
    drain_vs_nonstream_delta_tps: drainDeltaTps === null ? null : round(drainDeltaTps),
    drain_vs_nonstream_delta_pct: drainDeltaPct === null ? null : round(drainDeltaPct),
    drain_vs_nonstream_overhead_ms_per_token: drainOverhead === null ? null : round(drainOverhead, 6),
    production_vs_drain_delta_tps: productionDeltaTps === null ? null : round(productionDeltaTps),
    production_vs_drain_delta_pct: productionDeltaPct === null ? null : round(productionDeltaPct),
    production_vs_drain_overhead_ms_per_token: productionOverhead === null ? null : round(productionOverhead, 6),
    paired_server_path: paired.server,
    paired_production_consumer: paired.production,
    server_path_assessment: serverAssessment,
    production_consumer_assessment: productionAssessment,
    interpretation,
  };
}

export async function resetLlamaSlot(baseUrl: string, slotId: number): Promise<void> {
  const error = await eraseLlamaSlot(baseUrl, slotId);
  if (error) throw new Error(`slot reset failed: ${error}`);
}

async function monitorMemory<T>(
  pid: number | undefined,
  sample: (pid: number) => Promise<MetricSample>,
  operation: () => Promise<T>,
): Promise<{ value: T; memory: UatMemorySummary }> {
  if (!pid) {
    return {
      value: await operation(),
      memory: {
        gpu_mem_baseline_mib: null, gpu_mem_peak_mib: null,
        process_vram_peak_mib: null, ram_growth_peak_mib: null,
      },
    };
  }
  const samples: MetricSample[] = [];
  let active = true;
  const baseline = await sample(pid).catch(() => null);
  if (baseline) samples.push(baseline);
  const polling = (async () => {
    while (active) {
      await delay(150);
      if (!active) break;
      const current = await sample(pid).catch(() => null);
      if (current) samples.push(current);
    }
  })();
  try {
    const value = await operation();
    const processSamples = samples.map((item) => item.process_vram_mib).filter((item) => item >= 0);
    return {
      value,
      memory: {
        gpu_mem_baseline_mib: finite(baseline?.gpu_mem_mib),
        gpu_mem_peak_mib: finite(samples.length ? Math.max(...samples.map((item) => item.gpu_mem_mib)) : null),
        process_vram_peak_mib: finite(processSamples.length ? Math.max(...processSamples) : null),
        ram_growth_peak_mib: baseline && samples.length
          ? Math.max(0, baseline.ram_avail_mib - Math.min(...samples.map((item) => item.ram_avail_mib)))
          : null,
      },
    };
  } finally {
    active = false;
    await polling;
  }
}

function serverTps(timings: LlamaTimings | null): number | null {
  const n = finite(timings?.predicted_n);
  const ms = finite(timings?.predicted_ms);
  return n !== null && ms !== null && ms > 0 ? round(n * 1000 / ms) : null;
}

function makeRun(
  payload: StreamingOverheadPayload,
  mode: UatMode,
  repetition: number,
  order: number,
  result: NonStreamingChatCompletionResult | StreamingChatCompletionResult,
  events: StreamTelemetryEvent[],
  memory: UatMemorySummary,
  maxTokens: number,
): StreamingOverheadRun {
  const timings = "latency" in result ? result.latency.timings : result.timings;
  const generated = events.filter((event) => event.kind === "reasoning" || event.kind === "answer");
  const first = generated[0]?.at_ms;
  const last = generated.at(-1)?.at_ms;
  const clientMs = first === undefined || last === undefined || last <= first ? null : last - first;
  const predictedN = finite(timings?.predicted_n);
  const cacheN = finite(timings?.cache_n);
  return {
    config: payload.config,
    mode,
    repetition,
    order,
    ok: result.ok,
    status: result.status,
    ...(!result.ok && result.error ? { error: result.error } : {}),
    prompt_n: finite(timings?.prompt_n),
    prompt_ms: finite(timings?.prompt_ms),
    predicted_n: predictedN,
    predicted_ms: finite(timings?.predicted_ms),
    server_eval_tps: serverTps(timings),
    client_first_to_last_ms: clientMs === null ? null : round(clientMs),
    client_eval_tps: clientMs === null || predictedN === null || predictedN < 2
      ? null
      : round((predictedN - 1) * 1000 / clientMs),
    cache_n: cacheN,
    exact_token_count: predictedN === maxTokens,
    cache_empty: cacheN === null ? null : cacheN === 0,
    total_request_ms: result.total_request_ms,
    memory,
  };
}

export async function runStreamingOverheadUat(
  payload: StreamingOverheadPayload,
  deps: RunDeps = {},
): Promise<StreamingOverheadOutput> {
  const repetitions = Math.max(1, Math.trunc(payload.repetitions ?? 8));
  const maxTokens = Math.max(2, Math.trunc(payload.maxTokens ?? 256));
  const slotId = Math.max(0, Math.trunc(payload.slotId ?? 0));
  const cooldownMs = Math.max(0, Math.trunc(payload.cooldownMs ?? 500));
  const order = buildBalancedOrder(repetitions);
  const reset = deps.resetSlot ?? resetLlamaSlot;
  const wait = deps.sleep ?? delay;
  const sample = deps.sample ?? ((pid: number) => collectMetricSample(pid));
  const baseRequest = () => buildChatCompletionRequest({
    prompt: payload.prompt,
    maxTokens,
    cachePrompt: false,
    reasoningMode: payload.reasoningOff ? "off" : "default",
    temperature: 0,
    seed: payload.seed ?? 42,
    ignoreEos: true,
    idSlot: slotId,
  });
  const runNonstream = deps.runNonstream ?? ((request) => runNonStreamingChatCompletion({
    baseUrl: payload.baseUrl, request, timeoutMs: payload.timeoutMs,
  }));
  const runStream = deps.runStream ?? ((request, onEvent, deferEventProcessing) => runStreamingChatCompletion({
    baseUrl: payload.baseUrl,
    request,
    timeoutMs: payload.timeoutMs,
    onStreamEvent: onEvent,
    deferEventProcessing,
  }));

  deps.progress?.("warmup");
  await reset(payload.baseUrl, slotId);
  const warmup = await runNonstream({ ...baseRequest(), max_tokens: Math.min(32, maxTokens) });
  if (!warmup.ok) throw new Error(`warmup failed: ${warmup.error ?? `HTTP ${warmup.status}`}`);

  const rows: StreamingOverheadRun[] = [];
  const repetitionsSeen: Record<UatMode, number> = {
    nonstream: 0,
    stream_drain: 0,
    stream_production: 0,
  };
  for (let index = 0; index < order.length; index++) {
    const mode = order[index];
    repetitionsSeen[mode]++;
    deps.progress?.(`${index + 1}/${order.length} ${mode} rep ${repetitionsSeen[mode]}`);
    await reset(payload.baseUrl, slotId);
    const events: StreamTelemetryEvent[] = [];
    const productionTelemetry: Record<string, unknown>[] = [];
    const productionState: ProductionStreamState = {
      inferencePhase: "latency_prompt",
      previousServerN: null,
      previousServerMs: null,
    };
    const consumeProductionStreamEvent = createProductionStreamConsumer({
      state: productionState,
      minimalPolling: false,
      appendTelemetry: (extra) => {
        productionTelemetry.push({
          elapsed_ms: events.at(-1)?.at_ms ?? 0,
          phase: productionState.inferencePhase,
          ...extra,
          vram_total_mib: 0,
          vram_run_mib: 0,
          ram_used_mib: 0,
          shared_mib: 0,
          gpu_util_pct: null,
          cpu_util_pct: null,
        });
      },
    });
    const monitored = await monitorMemory(payload.metricsPid, sample, async () => {
      const request = mode !== "nonstream"
        ? { ...baseRequest(), stream: true, timings_per_token: true }
        : baseRequest();
      return mode !== "nonstream"
        ? runStream(request, (event) => {
          events.push(event);
          if (mode === "stream_production") {
            consumeProductionStreamEvent(event);
          }
        }, mode === "stream_drain")
        : runNonstream(request);
    });
    rows.push(makeRun(
      payload, mode, repetitionsSeen[mode], index + 1,
      monitored.value, events, monitored.memory, maxTokens,
    ));
    if (index < order.length - 1 && cooldownMs > 0) await wait(cooldownMs);
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    config: payload.config,
    max_tokens: maxTokens,
    repetitions_per_mode: repetitions,
    order,
    runs: rows,
    summary: summarizeStreamingOverhead(rows, maxTokens),
  };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function loadPayload(): Promise<StreamingOverheadPayload> {
  const payloadAt = process.argv.indexOf("--payload");
  const text = payloadAt >= 0 && process.argv[payloadAt + 1]
    ? await readFile(process.argv[payloadAt + 1], "utf8")
    : await readStdin();
  if (!text.trim()) throw new Error("pass JSON on stdin or with --payload <file>");
  return JSON.parse(text) as StreamingOverheadPayload;
}

function stopOwnedServer(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

async function main(): Promise<void> {
  const payload = await loadPayload();
  let child: ChildProcess | null = null;
  try {
    if (payload.server) {
      child = spawn(payload.server.executable, payload.server.args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "inherit"],
      });
      payload.metricsPid ??= child.pid;
      const ready = await waitForServerReady(payload.baseUrl, payload.server.readyTimeoutMs ?? 120000, 250, {
        isExited: () => child?.exitCode !== null,
      });
      if (!ready.ready) throw new Error(`llama-server did not become ready: ${ready.reason}`);
    }
    const result = await runStreamingOverheadUat(payload, {
      progress: (message) => process.stderr.write(`[stream-overhead] ${message}\n`),
    });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    const outAt = process.argv.indexOf("--out");
    if (outAt >= 0 && process.argv[outAt + 1]) {
      await writeFile(process.argv[outAt + 1], json, "utf8");
      process.stderr.write(`[stream-overhead] wrote ${process.argv[outAt + 1]}\n`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    if (child) stopOwnedServer(child);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
