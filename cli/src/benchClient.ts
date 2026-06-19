export interface ChatCompletionRequestOptions {
  prompt: string;
  maxTokens: number;
  stream?: boolean;
  cachePrompt?: boolean;
  reasoningMode?: "off" | "default";
  temperature?: number;
  seed?: number;
  ignoreEos?: boolean;
  idSlot?: number;
}

export interface ChatCompletionRequest {
  messages: Array<{ role: "user"; content: string }>;
  max_tokens: number;
  temperature: number;
  stream: boolean;
  cache_prompt: boolean;
  enable_thinking?: boolean;
  timings_per_token?: boolean;
  return_progress?: boolean;
  seed?: number;
  ignore_eos?: boolean;
  id_slot?: number;
}

export interface LlamaTimings {
  prompt_n?: number | null;
  prompt_per_second?: number | null;
  prompt_ms?: number | null;
  predicted_n?: number | null;
  predicted_per_second?: number | null;
  predicted_ms?: number | null;
  cache_n?: number | null;
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
  ttfh_ms: number | null;
  stream_open_ms: number | null;
  ttfr_ms: number | null;
  client_ttft_ms: number | null;
  e2e_ttft_ms: number | null;
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

export async function eraseLlamaSlot(baseUrl: string, slotId = 0): Promise<string | null> {
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/slots/${Math.max(0, Math.trunc(slotId))}?action=erase`,
      { method: "POST" },
    );
    return response.ok ? null : `HTTP ${response.status}: ${await response.text()}`;
  } catch (error) {
    return errorMessage(error);
  }
}

type ParsedSseData =
  | { kind: "done" }
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string };

export function buildChatCompletionRequest(opts: ChatCompletionRequestOptions): ChatCompletionRequest {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: opts.prompt }],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0.0,
    stream: opts.stream ?? false,
    cache_prompt: opts.cachePrompt ?? false,
  };
  if (opts.reasoningMode === "off") request.enable_thinking = false;
  if (opts.seed !== undefined) request.seed = opts.seed;
  if (opts.ignoreEos !== undefined) request.ignore_eos = opts.ignoreEos;
  if (opts.idSlot !== undefined) request.id_slot = opts.idSlot;
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
    const directReasoning = choice.reasoning_content;
    if (isRecord(delta) && typeof delta.content === "string") out += delta.content;
    else if (isRecord(delta) && typeof delta.reasoning_content === "string") out += delta.reasoning_content;
    else if (isRecord(message) && typeof message.content === "string") out += message.content;
    else if (isRecord(message) && typeof message.reasoning_content === "string") out += message.reasoning_content;
    else if (typeof directText === "string") out += directText;
    else if (typeof directReasoning === "string") out += directReasoning;
  }
  return out;
}

function extractTimings(value: unknown): LlamaTimings | null {
  if (!isRecord(value)) return null;
  return isRecord(value.timings) ? value.timings as LlamaTimings : null;
}

function extractPromptProgress(value: unknown): PromptProgress | null {
  if (!isRecord(value)) return null;
  return isRecord(value.prompt_progress) ? value.prompt_progress as PromptProgress : null;
}

function extractTextDeltas(value: unknown): { reasoning: string; content: string } {
  if (!isRecord(value) || !Array.isArray(value.choices)) return { reasoning: "", content: "" };
  let reasoning = "";
  let content = "";
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    if (typeof choice.delta.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
    if (typeof choice.delta.content === "string") content += choice.delta.content;
  }
  return { reasoning, content };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function deriveStreamMetrics(
  events: StreamTelemetryEvent[],
  ttfhMs: number | null,
  totalMs: number,
  timings: LlamaTimings | null,
): StreamLatencyMetrics {
  const open = events.find((event) => event.kind === "stream_open");
  const reasoning = events.find((event) => event.kind === "reasoning");
  const content = events.find((event) => event.kind === "answer");
  const firstOutput = [reasoning?.at_ms, content?.at_ms]
    .filter((value): value is number => value != null).sort((a, b) => a - b)[0] ?? null;
  const timed = events.filter((event) =>
    event.timings?.predicted_n != null && event.timings?.predicted_ms != null
  );
  const firstToken = timed.find((event) => Number(event.timings?.predicted_n) === 1);
  const lastToken = timed.at(-1);
  const firstN = Number(firstToken?.timings?.predicted_n ?? 0);
  const firstMs = Number(firstToken?.timings?.predicted_ms ?? 0);
  const lastN = Number(lastToken?.timings?.predicted_n ?? 0);
  const lastMs = Number(lastToken?.timings?.predicted_ms ?? 0);
  const intervals: number[] = [];
  for (let index = 1; index < timed.length; index++) {
    const previous = timed[index - 1].timings!;
    const current = timed[index].timings!;
    const deltaN = Number(current.predicted_n ?? 0) - Number(previous.predicted_n ?? 0);
    const deltaMs = Number(current.predicted_ms ?? 0) - Number(previous.predicted_ms ?? 0);
    if (deltaN > 0 && deltaMs >= 0) intervals.push(deltaMs / deltaN);
  }
  const gaps = events
    .filter((event) => event.kind === "reasoning" || event.kind === "answer")
    .map((event) => event.delivery_gap_ms)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const prefillRaw = firstToken?.timings?.prompt_ms ?? timings?.prompt_ms;
  const prefillMs = typeof prefillRaw === "number" && Number.isFinite(prefillRaw) ? prefillRaw : null;
  const p95 = percentile(intervals, 0.95);
  const gapMedian = percentile(gaps, 0.5);
  const gapP95 = percentile(gaps, 0.95);
  return {
    ttfh_ms: ttfhMs,
    stream_open_ms: open?.at_ms ?? null,
    ttfr_ms: open?.at_ms ?? null,
    client_ttft_ms: firstOutput,
    e2e_ttft_ms: firstOutput,
    e2e_first_reasoning_ms: reasoning?.at_ms ?? null,
    e2e_first_content_ms: content?.at_ms ?? null,
    reasoning_delay_ms: reasoning && content ? round(content.at_ms - reasoning.at_ms, 2) : null,
    e2e_latency_ms: totalMs,
    server_prefill_ms: prefillMs === null ? null : round(prefillMs, 2),
    server_ttft_ms: firstToken && prefillMs !== null ? round(prefillMs + firstMs, 2) : null,
    tpot_ms: lastN > firstN ? round((lastMs - firstMs) / (lastN - firstN), 3) : null,
    itl_p95_ms: p95 === null ? null : round(p95, 3),
    delivery_gap_median_ms: gapMedian === null ? null : round(gapMedian, 2),
    delivery_gap_p95_ms: gapP95 === null ? null : round(gapP95, 2),
    delivery_gap_max_ms: gaps.length ? round(Math.max(...gaps), 2) : null,
    response_chunk_count: events.length,
    content_chunk_count: events.filter((event) => event.kind === "reasoning" || event.kind === "answer").length,
    timings,
  };
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
    ttfh_ms: null,
    stream_open_ms: firstResponseAt === null ? null : round(firstResponseAt - startMs, 2),
    ttfr_ms: firstResponseAt === null ? null : round(firstResponseAt - startMs, 2),
    client_ttft_ms: firstContentAt === null ? null : round(firstContentAt - startMs, 2),
    e2e_ttft_ms: firstContentAt === null ? null : round(firstContentAt - startMs, 2),
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
  onStreamEvent?: (event: StreamTelemetryEvent) => void;
  deferEventProcessing?: boolean;
}

export interface PromptProgress {
  total?: number | null;
  cache?: number | null;
  processed?: number | null;
  time_ms?: number | null;
}

export interface StreamTelemetryEvent {
  at_ms: number;
  index: number;
  kind: "stream_open" | "prefill" | "reasoning" | "answer";
  text?: string;
  timings?: LlamaTimings | null;
  prompt_progress?: PromptProgress | null;
  delivery_gap_ms?: number | null;
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
  return {
    ttfh_ms: null, stream_open_ms: null, ttfr_ms: null, client_ttft_ms: null, e2e_ttft_ms: null,
    e2e_first_reasoning_ms: null, e2e_first_content_ms: null, reasoning_delay_ms: null,
    e2e_latency_ms: null, server_prefill_ms: null, server_ttft_ms: null, tpot_ms: null,
    itl_p95_ms: null, delivery_gap_median_ms: null, delivery_gap_p95_ms: null,
    delivery_gap_max_ms: null, response_chunk_count: 0, content_chunk_count: 0, timings: null,
  };
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
    const ttfhMs = round(now() - started, 2);

    if (!resp.ok) return fail(resp.status, await responseText(resp) || `HTTP ${resp.status}`);
    if (!resp.body) return fail(resp.status, "response had no readable stream body");

    // Timestamp each parsed chunk as it lands. SSE events can be split across
    // transport parts, so buffer until a newline before emitting a chunk; that
    // way analyzeChatCompletionStream never sees a half-written `data:` line.
    const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    const chunks: TimedStreamChunk[] = [];
    const telemetryEvents: StreamTelemetryEvent[] = [];
    let buffer = "";
    let eventIndex = 0;
    let streamOpened = false;
    let lastTextAt: number | null = null;

    const processEvents = (text: string, atMs: number) => {
      for (const event of parseSseDataLines(text)) {
        if (event.kind !== "json") continue;
        if (!streamOpened) {
          streamOpened = true;
          const opened: StreamTelemetryEvent = { at_ms: atMs, index: eventIndex++, kind: "stream_open" };
          telemetryEvents.push(opened);
          opts.onStreamEvent?.(opened);
        }
        const timings = extractTimings(event.value);
        const promptProgress = extractPromptProgress(event.value);
        if (promptProgress) {
          const prefill: StreamTelemetryEvent = {
            at_ms: atMs, index: eventIndex++, kind: "prefill", timings, prompt_progress: promptProgress,
          };
          telemetryEvents.push(prefill);
          opts.onStreamEvent?.(prefill);
        }
        const deltas = extractTextDeltas(event.value);
        for (const [kind, value] of [["reasoning", deltas.reasoning], ["answer", deltas.content]] as const) {
          if (!value) continue;
          const streamed: StreamTelemetryEvent = {
            at_ms: atMs,
            index: eventIndex++,
            kind,
            text: value,
            timings,
            delivery_gap_ms: lastTextAt === null ? null : round(atMs - lastTextAt, 2),
          };
          lastTextAt = atMs;
          telemetryEvents.push(streamed);
          opts.onStreamEvent?.(streamed);
        }
      }
    };

    for await (const part of readStreamParts(resp.body)) {
      buffer += typeof part === "string" ? part : decoder ? decoder.decode(part, { stream: true }) : "";
      const newlineAt = buffer.lastIndexOf("\n");
      if (newlineAt === -1) continue;
      const atMs = round(now() - started, 2);
      const text = buffer.slice(0, newlineAt + 1);
      chunks.push({ atMs, text });
      if (!opts.deferEventProcessing) processEvents(text, atMs);
      buffer = buffer.slice(newlineAt + 1);
    }
    if (decoder) buffer += decoder.decode();
    if (buffer.length > 0) chunks.push({ atMs: round(now() - started, 2), text: buffer });
    if (opts.deferEventProcessing) {
      for (const chunk of chunks) processEvents(chunk.text, chunk.atMs);
    }

    const totalMs = round(now() - started, 2);
    const analyzed = analyzeChatCompletionStream(chunks, 0);
    const latency = deriveStreamMetrics(telemetryEvents, ttfhMs, totalMs, analyzed.timings);

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
