// Node entrypoint for the complete HTTP benchmark sequence: optional warmup,
// non-streaming throughput, then a short streaming latency pass. PowerShell
// wraps this process in the hardware poller and maps its single JSON result.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildChatCompletionRequest,
  runNonStreamingChatCompletion,
  runStreamingChatCompletion,
  type LlamaTimings,
  type RunNonStreamingChatCompletionOptions,
  type RunStreamingChatCompletionOptions,
} from "./benchClient.js";

export interface BenchRunnerPayload {
  baseUrl: string;
  prompt: string;
  maxTokens: number;
  warmup?: boolean;
  warmupMaxTokens?: number;
  latencyMaxTokens?: number;
  reasoningOff?: boolean;
  timeoutMs?: number;
}

export interface BenchRunnerOutput {
  ok: boolean;
  status: number;
  total_request_ms: number;
  timings: LlamaTimings | null;
  ttfr_ms: number | null;
  e2e_ttft_ms: number | null;
  latency_total_request_ms: number | null;
  warmup_error?: string;
  latency_error?: string;
  error?: string;
}

export interface BenchRunnerDeps {
  fetchImpl?: RunNonStreamingChatCompletionOptions["fetchImpl"];
  streamFetchImpl?: RunStreamingChatCompletionOptions["fetchImpl"];
  nowMs?: () => number;
  onPhase?: (phase: "warmup" | "throughput" | "latency_prompt") => void;
  onContentEvent?: RunStreamingChatCompletionOptions["onContentEvent"];
}

export async function runFromPayload(
  payload: BenchRunnerPayload,
  deps: BenchRunnerDeps = {},
): Promise<BenchRunnerOutput> {
  const requestFor = (maxTokens: number, stream: boolean, cachePrompt: boolean) => buildChatCompletionRequest({
    prompt: payload.prompt,
    maxTokens,
    stream,
    cachePrompt,
    reasoningMode: payload.reasoningOff ? "off" : "default",
  });

  let warmupError: string | undefined;
  if (payload.warmup) {
    deps.onPhase?.("warmup");
    const warmup = await runNonStreamingChatCompletion({
      baseUrl: payload.baseUrl,
      request: requestFor(payload.warmupMaxTokens ?? 8, false, true),
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
      timeoutMs: payload.timeoutMs,
    });
    if (!warmup.ok) warmupError = warmup.error ?? `HTTP ${warmup.status}`;
  }

  deps.onPhase?.("throughput");
  const throughput = await runNonStreamingChatCompletion({
    baseUrl: payload.baseUrl,
    request: requestFor(payload.maxTokens, false, false),
    fetchImpl: deps.fetchImpl,
    nowMs: deps.nowMs,
    timeoutMs: payload.timeoutMs,
  });
  if (!throughput.ok) {
    return {
      ok: false,
      status: throughput.status,
      total_request_ms: throughput.total_request_ms,
      timings: null,
      ttfr_ms: null,
      e2e_ttft_ms: null,
      latency_total_request_ms: null,
      ...(warmupError ? { warmup_error: warmupError } : {}),
      ...(throughput.error ? { error: throughput.error } : {}),
    };
  }

  deps.onPhase?.("latency_prompt");
  const latency = await runStreamingChatCompletion({
    baseUrl: payload.baseUrl,
    request: requestFor(Math.min(payload.maxTokens, payload.latencyMaxTokens ?? 32), true, false),
    fetchImpl: deps.streamFetchImpl,
    nowMs: deps.nowMs,
    timeoutMs: payload.timeoutMs,
    onContentEvent: deps.onContentEvent,
  });
  return {
    ok: true,
    status: throughput.status,
    total_request_ms: throughput.total_request_ms,
    timings: throughput.timings,
    ttfr_ms: latency.ok ? latency.latency.ttfr_ms : null,
    e2e_ttft_ms: latency.ok ? latency.latency.e2e_ttft_ms : null,
    latency_total_request_ms: latency.total_request_ms,
    ...(warmupError ? { warmup_error: warmupError } : {}),
    ...(!latency.ok ? { latency_error: latency.error ?? `HTTP ${latency.status}` } : {}),
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
    latency_total_request_ms: null,
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
