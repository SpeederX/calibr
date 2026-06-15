export interface ChatCompletionRequestOptions {
  prompt: string;
  maxTokens: number;
  stream?: boolean;
  cachePrompt?: boolean;
  reasoningMode?: "off" | "default";
}

export interface ChatCompletionRequest {
  messages: Array<{ role: "user"; content: string }>;
  max_tokens: number;
  temperature: number;
  stream: boolean;
  cache_prompt: boolean;
  enable_thinking?: boolean;
}

export interface LlamaTimings {
  prompt_n?: number | null;
  prompt_per_second?: number | null;
  prompt_ms?: number | null;
  predicted_n?: number | null;
  predicted_per_second?: number | null;
  predicted_ms?: number | null;
}

export interface BenchTimingMetrics {
  prompt_n: number | null;
  prompt_tps: number | null;
  prompt_ms: number | null;
  eval_n: number | null;
  eval_tps: number | null;
}

export interface TimedStreamChunk {
  atMs: number;
  text: string;
}

export interface StreamLatencyMetrics {
  ttfr_ms: number | null;
  e2e_ttft_ms: number | null;
  response_chunk_count: number;
  content_chunk_count: number;
  timings: LlamaTimings | null;
}

export interface NonStreamingChatCompletionResult {
  ok: boolean;
  status: number;
  total_request_ms: number;
  body: unknown | null;
  timings: LlamaTimings | null;
  metrics: BenchTimingMetrics;
  error?: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

type FetchLike = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export interface RunNonStreamingChatCompletionOptions {
  baseUrl: string;
  request: ChatCompletionRequest;
  fetchImpl?: FetchLike;
  nowMs?: () => number;
  timeoutMs?: number;
}

type ParsedSseData =
  | { kind: "done" }
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string };

export function buildChatCompletionRequest(opts: ChatCompletionRequestOptions): ChatCompletionRequest {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: opts.prompt }],
    max_tokens: opts.maxTokens,
    temperature: 0.0,
    stream: opts.stream ?? false,
    cache_prompt: opts.cachePrompt ?? false,
  };
  if (opts.reasoningMode === "off") request.enable_thinking = false;
  return request;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Optional request deadline shared by both runners. Returns a signal to thread
// into fetch (when AbortController exists) plus a clear() the caller runs in a
// finally, so a completed request never leaves a dangling timer.
function makeAbort(timeoutMs?: number): { signal?: AbortSignal; clear: () => void } {
  if (!timeoutMs || typeof AbortController === "undefined") return { clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export function metricsFromLlamaTimings(timings: LlamaTimings | null | undefined): BenchTimingMetrics {
  const promptN = finiteNumber(timings?.prompt_n);
  const promptPerSecond = finiteNumber(timings?.prompt_per_second);
  const promptMs = finiteNumber(timings?.prompt_ms);
  const predictedN = finiteNumber(timings?.predicted_n);
  const predictedPerSecond = finiteNumber(timings?.predicted_per_second);
  const predictedMs = finiteNumber(timings?.predicted_ms);

  return {
    prompt_n: promptN,
    prompt_tps: promptPerSecond === null ? null : round(promptPerSecond, 2),
    prompt_ms: promptMs === null ? null : round(promptMs, 2),
    eval_n: predictedN,
    // llama.cpp can report sentinel-level throughput when a response emits
    // too few tokens to time. Mirror the PowerShell guard before reporting it.
    eval_tps: predictedN !== null && predictedN >= 2 && predictedMs !== null && predictedMs > 0 && predictedPerSecond !== null
      ? round(predictedPerSecond, 2)
      : null,
  };
}

export function parseSseDataLines(text: string): ParsedSseData[] {
  const events: ParsedSseData[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      events.push({ kind: "done" });
      continue;
    }
    try {
      events.push({ kind: "json", value: JSON.parse(data) });
    } catch {
      events.push({ kind: "text", value: data });
    }
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractContentDelta(value: unknown): string {
  if (!isRecord(value)) return "";
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  let out = "";
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice.delta;
    const message = choice.message;
    const directText = choice.text;
    if (isRecord(delta) && typeof delta.content === "string") out += delta.content;
    else if (isRecord(message) && typeof message.content === "string") out += message.content;
    else if (typeof directText === "string") out += directText;
  }
  return out;
}

function extractTimings(value: unknown): LlamaTimings | null {
  if (!isRecord(value)) return null;
  return isRecord(value.timings) ? value.timings as LlamaTimings : null;
}

function completionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
}

async function responseText(resp: { text?(): Promise<string> }): Promise<string> {
  if (!resp.text) return "";
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

export async function runNonStreamingChatCompletion(
  opts: RunNonStreamingChatCompletionOptions,
): Promise<NonStreamingChatCompletionResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) throw new Error("fetch is not available in this runtime");

  const now = opts.nowMs ?? (() => Date.now());
  const started = now();
  const abort = makeAbort(opts.timeoutMs);

  try {
    const resp = await fetchImpl(completionUrl(opts.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...opts.request, stream: false }),
      ...(abort.signal ? { signal: abort.signal } : {}),
    });
    const totalMs = round(now() - started, 2);
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        total_request_ms: totalMs,
        body: null,
        timings: null,
        metrics: metricsFromLlamaTimings(null),
        error: await responseText(resp) || `HTTP ${resp.status}`,
      };
    }

    const body = await resp.json();
    const timings = extractTimings(body);
    return {
      ok: true,
      status: resp.status,
      total_request_ms: totalMs,
      body,
      timings,
      metrics: metricsFromLlamaTimings(timings),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      total_request_ms: round(now() - started, 2),
      body: null,
      timings: null,
      metrics: metricsFromLlamaTimings(null),
      error: errorMessage(error),
    };
  } finally {
    abort.clear();
  }
}

export function analyzeChatCompletionStream(chunks: TimedStreamChunk[], startMs = 0): StreamLatencyMetrics {
  let firstResponseAt: number | null = null;
  let firstContentAt: number | null = null;
  let responseChunkCount = 0;
  let contentChunkCount = 0;
  let timings: LlamaTimings | null = null;

  for (const chunk of chunks) {
    const events = parseSseDataLines(chunk.text);
    for (const event of events) {
      if (event.kind === "done") continue;
      responseChunkCount++;
      if (firstResponseAt === null) firstResponseAt = chunk.atMs;

      if (event.kind === "json") {
        const content = extractContentDelta(event.value);
        if (content.length > 0) {
          contentChunkCount++;
          if (firstContentAt === null) firstContentAt = chunk.atMs;
        }
        timings = extractTimings(event.value) ?? timings;
      }
    }
  }

  return {
    ttfr_ms: firstResponseAt === null ? null : round(firstResponseAt - startMs, 2),
    e2e_ttft_ms: firstContentAt === null ? null : round(firstContentAt - startMs, 2),
    response_chunk_count: responseChunkCount,
    content_chunk_count: contentChunkCount,
    timings,
  };
}

// A streamed body is either an async-iterable of byte/text parts (Node's
// `fetch().body`, or a test generator) or a ReadableStream exposing getReader().
type StreamBody =
  | AsyncIterable<Uint8Array | string>
  | { getReader(): { read(): Promise<{ value?: Uint8Array | string; done: boolean }> } };

interface StreamFetchResponseLike {
  ok: boolean;
  status: number;
  body?: StreamBody | null;
  text?(): Promise<string>;
}

type StreamFetchLike = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<StreamFetchResponseLike>;

export interface RunStreamingChatCompletionOptions {
  baseUrl: string;
  request: ChatCompletionRequest;
  fetchImpl?: StreamFetchLike;
  nowMs?: () => number;
  timeoutMs?: number;
}

export interface StreamingChatCompletionResult {
  ok: boolean;
  status: number;
  total_request_ms: number;
  content: string;
  latency: StreamLatencyMetrics;
  metrics: BenchTimingMetrics;
  error?: string;
}

function emptyLatency(): StreamLatencyMetrics {
  return { ttfr_ms: null, e2e_ttft_ms: null, response_chunk_count: 0, content_chunk_count: 0, timings: null };
}

// Normalize both body shapes to a single async iterator so the runner does not
// branch on whether it got a generator (tests) or a ReadableStream (real fetch).
async function* readStreamParts(body: StreamBody): AsyncGenerator<Uint8Array | string> {
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    for await (const part of body as AsyncIterable<Uint8Array | string>) yield part;
    return;
  }
  const reader = (body as { getReader?: () => { read(): Promise<{ value?: Uint8Array | string; done: boolean }> } }).getReader?.();
  if (!reader) return;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) yield value;
  }
}

export async function runStreamingChatCompletion(
  opts: RunStreamingChatCompletionOptions,
): Promise<StreamingChatCompletionResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as StreamFetchLike | undefined);
  if (!fetchImpl) throw new Error("fetch is not available in this runtime");

  const now = opts.nowMs ?? (() => Date.now());
  const started = now();
  const abort = makeAbort(opts.timeoutMs);

  const fail = (status: number, error: string): StreamingChatCompletionResult => ({
    ok: false,
    status,
    total_request_ms: round(now() - started, 2),
    content: "",
    latency: emptyLatency(),
    metrics: metricsFromLlamaTimings(null),
    error,
  });

  try {
    const resp = await fetchImpl(completionUrl(opts.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...opts.request, stream: true }),
      ...(abort.signal ? { signal: abort.signal } : {}),
    });

    if (!resp.ok) return fail(resp.status, await responseText(resp) || `HTTP ${resp.status}`);
    if (!resp.body) return fail(resp.status, "response had no readable stream body");

    // Timestamp each parsed chunk as it lands. SSE events can be split across
    // transport parts, so buffer until a newline before emitting a chunk; that
    // way analyzeChatCompletionStream never sees a half-written `data:` line.
    const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    const chunks: TimedStreamChunk[] = [];
    let buffer = "";

    for await (const part of readStreamParts(resp.body)) {
      buffer += typeof part === "string" ? part : decoder ? decoder.decode(part, { stream: true }) : "";
      const newlineAt = buffer.lastIndexOf("\n");
      if (newlineAt === -1) continue;
      chunks.push({ atMs: round(now() - started, 2), text: buffer.slice(0, newlineAt + 1) });
      buffer = buffer.slice(newlineAt + 1);
    }
    if (decoder) buffer += decoder.decode();
    if (buffer.length > 0) chunks.push({ atMs: round(now() - started, 2), text: buffer });

    const totalMs = round(now() - started, 2);
    const latency = analyzeChatCompletionStream(chunks, 0);

    let content = "";
    for (const chunk of chunks) {
      for (const event of parseSseDataLines(chunk.text)) {
        if (event.kind === "json") content += extractContentDelta(event.value);
      }
    }

    return {
      ok: true,
      status: resp.status,
      total_request_ms: totalMs,
      content,
      latency,
      metrics: metricsFromLlamaTimings(latency.timings),
    };
  } catch (error) {
    return fail(0, errorMessage(error));
  } finally {
    abort.clear();
  }
}
