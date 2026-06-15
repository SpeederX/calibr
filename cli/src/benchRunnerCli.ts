// Thin Node entrypoint the PowerShell engine shells out to when the opt-in
// CALIBR_TS_BENCH path is active. It owns nothing about the llama-server
// lifecycle — bench.ps1 still launches the server, polls readiness, and takes
// GPU/RAM snapshots. This process only performs the single chat/completions
// request and prints one JSON line that bench.ps1 maps into a run record.
//
// Contract (stdin, --json <payload>, or --json-file <path>): a JSON object
//   { baseUrl, prompt, maxTokens, stream?, cachePrompt?, reasoningOff?, timeoutMs? }
// Output (stdout, one line): BenchRunnerOutput. The `timings` field mirrors
// llama.cpp's shape so the engine's existing metric mapping is untouched.
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
  stream?: boolean;
  cachePrompt?: boolean;
  reasoningOff?: boolean;
  timeoutMs?: number;
}

export interface BenchRunnerOutput {
  ok: boolean;
  mode: "stream" | "nostream";
  status: number;
  total_request_ms: number;
  timings: LlamaTimings | null;
  ttfr_ms: number | null;
  e2e_ttft_ms: number | null;
  error?: string;
}

export interface BenchRunnerDeps {
  fetchImpl?: RunNonStreamingChatCompletionOptions["fetchImpl"];
  streamFetchImpl?: RunStreamingChatCompletionOptions["fetchImpl"];
  nowMs?: () => number;
}

export async function runFromPayload(
  payload: BenchRunnerPayload,
  deps: BenchRunnerDeps = {},
): Promise<BenchRunnerOutput> {
  const request = buildChatCompletionRequest({
    prompt: payload.prompt,
    maxTokens: payload.maxTokens,
    stream: payload.stream,
    cachePrompt: payload.cachePrompt,
    reasoningMode: payload.reasoningOff ? "off" : "default",
  });

  // Default to streaming; the engine currently opts into stream:false for a
  // clean parity check against the PowerShell path. Streaming stays one payload
  // flag away so ttfr_ms / e2e_ttft_ms can be wired in next.
  if (payload.stream === false) {
    const r = await runNonStreamingChatCompletion({
      baseUrl: payload.baseUrl,
      request,
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
      timeoutMs: payload.timeoutMs,
    });
    return {
      ok: r.ok,
      mode: "nostream",
      status: r.status,
      total_request_ms: r.total_request_ms,
      timings: r.timings,
      ttfr_ms: null,
      e2e_ttft_ms: null,
      ...(r.error ? { error: r.error } : {}),
    };
  }

  const r = await runStreamingChatCompletion({
    baseUrl: payload.baseUrl,
    request,
    fetchImpl: deps.streamFetchImpl,
    nowMs: deps.nowMs,
    timeoutMs: payload.timeoutMs,
  });
  return {
    ok: r.ok,
    mode: "stream",
    status: r.status,
    total_request_ms: r.total_request_ms,
    timings: r.latency.timings,
    ttfr_ms: r.latency.ttfr_ms,
    e2e_ttft_ms: r.latency.e2e_ttft_ms,
    ...(r.error ? { error: r.error } : {}),
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
  return { ok: false, mode: "stream", status: 0, total_request_ms: 0, timings: null, ttfr_ms: null, e2e_ttft_ms: null, error };
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

// Run only when invoked as a script, not when imported by the test module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
