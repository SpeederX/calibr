// Node entrypoint for the complete HTTP benchmark sequence: optional warmup,
// KV reset, then one measured streaming request. Its final server timings are
// the official throughput source; the same request also provides latency and
// per-token telemetry. PowerShell only wraps and maps the single JSON result.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildChatCompletionRequest,
  eraseLlamaSlot,
  runNonStreamingChatCompletion,
  runStreamingChatCompletion,
  type LlamaTimings,
  type RunNonStreamingChatCompletionOptions,
  type RunStreamingChatCompletionOptions,
} from "./benchClient.js";
import {
  prepareWorkloadPrompt,
  type WorkloadFetch,
  type WorkloadKind,
} from "./workloadPrompt.js";

export interface BenchRunnerPayload {
  baseUrl: string;
  prompt: string;
  maxTokens: number;
  warmup?: boolean;
  warmupMaxTokens?: number;
  slotId?: number;
  seed?: number;
  reasoningOff?: boolean;
  timeoutMs?: number;
  workloadKind?: WorkloadKind;
  prefillTargetTokens?: number;
  kvFillTargetTokens?: number;
}

export interface BenchRunnerOutput {
  ok: boolean;
  status: number;
  total_request_ms: number;
  timings: LlamaTimings | null;
  ttfr_ms: number | null;
  e2e_ttft_ms: number | null;
  ttfh_ms: number | null;
  stream_open_ms: number | null;
  client_ttft_ms: number | null;
  e2e_first_reasoning_ms: number | null;
  e2e_first_content_ms: number | null;
  reasoning_delay_ms: number | null;
  e2e_latency_ms: number | null;
  server_prefill_ms: number | null;
  server_ttft_ms: number | null;
  tpot_ms: number | null;
  itl_p95_ms: number | null;
  delivery_gap_median_ms: number | null;
  delivery_gap_p95_ms: number | null;
  delivery_gap_max_ms: number | null;
  latency_total_request_ms: number | null;
  warmup_error?: string;
  workload_prepare_ms: number | null;
  workload_prompt_tokens: number | null;
  workload_target_error_tokens: number | null;
  kv_fill_ms: number | null;
  kv_fill_cached_tokens: number | null;
  error?: string;
}

export interface BenchRunnerDeps {
  fetchImpl?: RunNonStreamingChatCompletionOptions["fetchImpl"];
  streamFetchImpl?: RunStreamingChatCompletionOptions["fetchImpl"];
  eraseSlot?: (baseUrl: string, slotId: number) => Promise<string | null>;
  nowMs?: () => number;
  workloadFetchImpl?: WorkloadFetch;
  onPhase?: (phase: "warmup" | "kv_fill" | "latency_prompt") => void;
  onStreamEvent?: RunStreamingChatCompletionOptions["onStreamEvent"];
}

export async function runFromPayload(
  payload: BenchRunnerPayload,
  deps: BenchRunnerDeps = {},
): Promise<BenchRunnerOutput> {
  const slotId = Math.max(0, Math.trunc(payload.slotId ?? 0));
  const prepareStarted = (deps.nowMs ?? Date.now)();
  let prepared;
  try {
    prepared = await prepareWorkloadPrompt({
      baseUrl: payload.baseUrl,
      basePrompt: payload.prompt,
      kind: payload.workloadKind,
      prefillTargetTokens: payload.prefillTargetTokens,
      kvFillTargetTokens: payload.kvFillTargetTokens,
      fetchImpl: deps.workloadFetchImpl,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  const workloadPrepareMs = Math.max(0, (deps.nowMs ?? Date.now)() - prepareStarted);
  const requestFor = (prompt: string, maxTokens: number, stream: boolean, cachePrompt: boolean) => ({
    ...buildChatCompletionRequest({
      prompt,
      maxTokens,
      stream,
      cachePrompt,
      reasoningMode: payload.reasoningOff ? "off" : "default",
      idSlot: slotId,
      seed: payload.seed ?? 42,
      ignoreEos: true,
    }),
    ...(stream ? { timings_per_token: true, return_progress: true } : {}),
  });

  let warmupError: string | undefined;
  if (payload.warmup) {
    deps.onPhase?.("warmup");
    const warmup = await runNonStreamingChatCompletion({
      baseUrl: payload.baseUrl,
      request: requestFor(payload.prompt, payload.warmupMaxTokens ?? 8, false, true),
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
      timeoutMs: payload.timeoutMs,
    });
    if (!warmup.ok) warmupError = warmup.error ?? `HTTP ${warmup.status}`;
    else {
      const resetError = await (deps.eraseSlot ?? eraseLlamaSlot)(payload.baseUrl, slotId);
      if (resetError) return {
        ...failure(`cache reset failed: ${resetError}`),
        status: 0,
      };
    }
  }

  let kvFillMs: number | null = null;
  if (prepared.kind === "kv-fill" && prepared.fillPrompt) {
    deps.onPhase?.("kv_fill");
    const fill = await runNonStreamingChatCompletion({
      baseUrl: payload.baseUrl,
      request: requestFor(prepared.fillPrompt, 1, false, true),
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
      timeoutMs: payload.timeoutMs,
    });
    kvFillMs = fill.total_request_ms;
    if (!fill.ok) {
      return {
        ...failure(`KV fill failed: ${fill.error ?? `HTTP ${fill.status}`}`),
        status: fill.status,
        workload_prepare_ms: workloadPrepareMs,
        workload_prompt_tokens: prepared.actualTokens,
        workload_target_error_tokens: prepared.targetErrorTokens,
        kv_fill_ms: kvFillMs,
      };
    }
  }

  deps.onPhase?.("latency_prompt");
  const measured = await runStreamingChatCompletion({
    baseUrl: payload.baseUrl,
    request: requestFor(prepared.measuredPrompt, payload.maxTokens, true, prepared.kind === "kv-fill"),
    fetchImpl: deps.streamFetchImpl,
    nowMs: deps.nowMs,
    timeoutMs: payload.timeoutMs,
    onStreamEvent: deps.onStreamEvent,
  });
  return {
    ok: measured.ok,
    status: measured.status,
    total_request_ms: measured.total_request_ms,
    timings: measured.ok ? measured.latency.timings : null,
    ttfr_ms: measured.ok ? measured.latency.ttfr_ms : null,
    e2e_ttft_ms: measured.ok ? measured.latency.e2e_ttft_ms : null,
    ttfh_ms: measured.ok ? measured.latency.ttfh_ms : null,
    stream_open_ms: measured.ok ? measured.latency.stream_open_ms : null,
    client_ttft_ms: measured.ok ? measured.latency.client_ttft_ms : null,
    e2e_first_reasoning_ms: measured.ok ? measured.latency.e2e_first_reasoning_ms : null,
    e2e_first_content_ms: measured.ok ? measured.latency.e2e_first_content_ms : null,
    reasoning_delay_ms: measured.ok ? measured.latency.reasoning_delay_ms : null,
    e2e_latency_ms: measured.ok ? measured.latency.e2e_latency_ms : null,
    server_prefill_ms: measured.ok ? measured.latency.server_prefill_ms : null,
    server_ttft_ms: measured.ok ? measured.latency.server_ttft_ms : null,
    tpot_ms: measured.ok ? measured.latency.tpot_ms : null,
    itl_p95_ms: measured.ok ? measured.latency.itl_p95_ms : null,
    delivery_gap_median_ms: measured.ok ? measured.latency.delivery_gap_median_ms : null,
    delivery_gap_p95_ms: measured.ok ? measured.latency.delivery_gap_p95_ms : null,
    delivery_gap_max_ms: measured.ok ? measured.latency.delivery_gap_max_ms : null,
    workload_prepare_ms: workloadPrepareMs,
    workload_prompt_tokens: prepared.kind === "baseline" ? null : prepared.actualTokens,
    workload_target_error_tokens: prepared.kind === "baseline" ? null : prepared.targetErrorTokens,
    kv_fill_ms: kvFillMs,
    kv_fill_cached_tokens: prepared.kind === "kv-fill"
      ? (measured.latency.timings?.cache_n ?? null)
      : null,
    // Legacy alias retained while existing result/report readers still carry
    // the old two-request field name. It now equals total_request_ms.
    latency_total_request_ms: measured.total_request_ms,
    ...(warmupError ? { warmup_error: warmupError } : {}),
    ...(!measured.ok ? { error: measured.error ?? `HTTP ${measured.status}` } : {}),
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function failure(error: string): BenchRunnerOutput {
  return {
    ok: false,
    status: 0,
    total_request_ms: 0,
    timings: null,
    ttfr_ms: null,
    e2e_ttft_ms: null,
    ttfh_ms: null, stream_open_ms: null, client_ttft_ms: null,
    e2e_first_reasoning_ms: null, e2e_first_content_ms: null, reasoning_delay_ms: null,
    e2e_latency_ms: null, server_prefill_ms: null, server_ttft_ms: null, tpot_ms: null,
    itl_p95_ms: null, delivery_gap_median_ms: null, delivery_gap_p95_ms: null,
    delivery_gap_max_ms: null,
    latency_total_request_ms: null,
    workload_prepare_ms: null,
    workload_prompt_tokens: null,
    workload_target_error_tokens: null,
    kv_fill_ms: null,
    kv_fill_cached_tokens: null,
    error,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf("--json");
  const jsonFileIdx = argv.indexOf("--json-file");
  let raw = "";
  if (jsonIdx >= 0) {
    raw = argv[jsonIdx + 1] ?? "";
  } else if (jsonFileIdx >= 0) {
    const path = argv[jsonFileIdx + 1] ?? "";
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      process.stdout.write(JSON.stringify(failure(`could not read payload file: ${error instanceof Error ? error.message : String(error)}`)) + "\n");
      return;
    }
  } else {
    raw = await readStdin();
  }

  let payload: BenchRunnerPayload;
  try {
    payload = JSON.parse(raw) as BenchRunnerPayload;
  } catch {
    process.stdout.write(JSON.stringify(failure("invalid payload json")) + "\n");
    return;
  }

  let out: BenchRunnerOutput;
  try {
    out = await runFromPayload(payload);
  } catch (error) {
    out = failure(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
